package app.hsn.push

import android.content.ContentValues
import android.content.Context
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import org.json.JSONObject
import java.security.KeyStore
import java.util.Base64
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/** Private, backup-excluded phone storage. Only the wrapping key lives in Android Keystore. */
internal class PushStore private constructor(context: Context) : SQLiteOpenHelper(context, "push.db", null, 1) {
    companion object {
        private var instance: PushStore? = null
        /** Gives the native bridge and messaging service one serialized database connection pool. */
        @Synchronized fun of(context: Context): PushStore = instance ?: PushStore(context.applicationContext).also { instance = it }
    }

    override fun onCreate(db: SQLiteDatabase) {
        db.execSQL("CREATE TABLE home(hub TEXT PRIMARY KEY, armed INTEGER DEFAULT 0, seq INTEGER, relay TEXT)")
        db.execSQL("CREATE TABLE keys(hub TEXT PRIMARY KEY, active TEXT, pending TEXT, secret BLOB NOT NULL)")
        db.execSQL("CREATE INDEX active_key ON keys(active)")
        db.execSQL("CREATE INDEX pending_key ON keys(pending)")
        db.execSQL("CREATE TABLE shown(hub TEXT, seq INTEGER, PRIMARY KEY(hub,seq)) WITHOUT ROWID")
        db.execSQL("CREATE TABLE names(hub TEXT PRIMARY KEY, name TEXT NOT NULL)")
    }
    override fun onUpgrade(db: SQLiteDatabase, old: Int, new: Int) = Unit

    /** Runs one atomic state transition, including cancellation and display for delivered alerts. */
    fun <T> transaction(block: (SQLiteDatabase) -> T): T {
        val db = writableDatabase
        db.beginTransaction()
        try {
            return block(db).also { db.setTransactionSuccessful() }
        } finally { db.endTransaction() }
    }

    /** Gets this install's non-exportable AES wrapping key; the screen lock need not be open. */
    @Synchronized private fun wrappingKey(): SecretKey {
        val alias = "notification-registration-v1"
        val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (ks.getKey(alias,null) as? SecretKey)?.let { return it }
        return KeyGenerator.getInstance("AES","AndroidKeyStore").apply {
            init(KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build())
        }.generateKey()
    }
    /** Opens the registration JSON, authenticating which home owns it. */
    private fun decode(hub: String, blob: ByteArray): JSONObject {
        val c = Cipher.getInstance("AES/GCM/NoPadding")
        c.init(Cipher.DECRYPT_MODE,wrappingKey(),GCMParameterSpec(128,blob,0,12))
        c.updateAAD(hub.toByteArray())
        return JSONObject(String(c.doFinal(blob,12,blob.size-12),Charsets.UTF_8))
    }

    /** Stores both acceptable generations in the same write as their lookup ids. */
    fun put(hub: String, record: Map<String,Any?>) {
        val obj = JSONObject(record)
        val c = Cipher.getInstance("AES/GCM/NoPadding")
        c.init(Cipher.ENCRYPT_MODE,wrappingKey())
        c.updateAAD(hub.toByteArray())
        val values = ContentValues().apply {
            put("hub",hub)
            for (field in listOf("active","pending")) put(field,obj.optJSONObject(field)?.getJSONObject("body")?.getString("keyId"))
            put("secret",c.iv+c.doFinal(obj.toString().toByteArray()))
        }
        writableDatabase.insertOrThrowReplacing("keys",values)
    }
    /** Returns the same registration structure that TypeScript persisted. */
    fun keys(hub: String): Fields = readableDatabase.rawQuery("SELECT secret FROM keys WHERE hub=?",arrayOf(hub)).use {
        if (it.moveToFirst()) fields(decode(hub,it.getBlob(0)).toString())!! else mapOf("active" to null,"pending" to null)
    }
    /** Locates the hub by routing id, then unwraps only that hub's matching key. */
    fun lookup(id: String): Target? = readableDatabase.rawQuery("SELECT hub,secret FROM keys WHERE active=? OR pending=?",arrayOf(id,id)).use {
        if (!it.moveToFirst() || it.count != 1) return null
        val hub = it.getString(0)
        val obj = decode(hub,it.getBlob(1))
        for (field in listOf("pending","active")) {
            val body = obj.optJSONObject(field)?.getJSONObject("body") ?: continue
            if (body.getString("keyId") == id) return Target(hub,Base64.getUrlDecoder().decode(body.getString("key")))
        }
        null
    }
    /** Remembers foreground state without replacing receiver-owned history or sequence fields. */
    fun arm(hub: String, armed: Boolean) = transaction { db ->
        db.execSQL("INSERT INTO home(hub,armed) VALUES(?,?) ON CONFLICT(hub) DO UPDATE SET armed=excluded.armed",arrayOf<Any>(hub,if(armed) 1 else 0))
    }
    /** Applies the phone's authoritative home names atomically. */
    fun homes(names: Map<String,String>) = transaction { db ->
        db.delete("names",null,null)
        for ((hub,name) in names) db.execSQL("INSERT INTO names VALUES(?,?)",arrayOf(hub,name))
    }
    /** Includes the home name when several homes are linked, even when only one has a target. */
    fun prefix(hub: String): String? = readableDatabase.rawQuery("SELECT name FROM names WHERE hub=? AND (SELECT count(*) FROM names)>1",arrayOf(hub)).use {
        if(it.moveToFirst()) it.getString(0).ifEmpty { null } else null
    }
    /** Erases only this home and its deduplication history. */
    fun remove(hub: String) = transaction { db ->
        for (table in listOf("home","keys","shown","names")) db.delete(table,"hub=?",arrayOf(hub))
    }
    /** Applies one authenticated alert; positive sequences can arrive out of order. */
    fun deliver(alert: Alert, post: (Display) -> Unit) = transaction { db ->
        val (armed,relay) = db.rawQuery("SELECT armed,relay FROM home WHERE hub=?",arrayOf(alert.hub)).use {
            if(it.moveToFirst()) (it.getInt(0)!=0) to it.getString(1) else false to null
        }
        val seen = db.rawQuery("SELECT 1 FROM shown WHERE hub=? AND seq=?",arrayOf(alert.hub,alert.seq.toString())).use { it.moveToFirst() }
        val decision = display(alert,armed,seen,relay) ?: return@transaction
        post(decision)
        db.execSQL("INSERT OR REPLACE INTO home VALUES(?,?,?,?)",arrayOf<Any?>(alert.hub, if(alert.armed) 1 else 0,alert.seq,if(alert.seq==0L) alert.kind else relay))
        db.execSQL("INSERT OR IGNORE INTO shown VALUES(?,?)",arrayOf<Any>(alert.hub,alert.seq))
    }
}

/** Uses SQLite's throwing insert variant so a full database cannot acknowledge a key write. */
private fun SQLiteDatabase.insertOrThrowReplacing(table: String, values: ContentValues) {
    check(insertWithOnConflict(table,null,values,SQLiteDatabase.CONFLICT_REPLACE) != -1L)
}

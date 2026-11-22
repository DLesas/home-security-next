// Spike S5, step 4: the Android messaging service's work, called by FCM's service and by the
// spike's stand-in alike. Throwaway.
//
// Opens `h` with javax.crypto's ChaCha20-Poly1305, words it from the app's translation file (an
// asset), and posts the notification itself: critical ones on a channel of the highest importance
// with an alarm sound, category alarm, asking to pass Do Not Disturb; the Disarm action as a
// broadcast to our own receiver. An alarm removes its device's shown countdown (tag hub, id by
// device). Every step is journaled to `files/app.jsonl` and logcat (tag HsnS5).
package expo.modules.hsnpush

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.media.AudioAttributes
import android.media.RingtoneManager
import android.os.Process
import android.util.Base64
import android.util.Log
import org.json.JSONObject
import java.io.File
import javax.crypto.Cipher
import javax.crypto.spec.IvParameterSpec
import javax.crypto.spec.SecretKeySpec

object Push {
  const val CRITICAL = "hsn.critical"
  const val ORDINARY = "hsn.ordinary"
  const val OUTCOME = "hsn.outcome"

  fun journal(context: Context, event: String, detail: Map<String, Any?> = emptyMap()) {
    val line = JSONObject()
    for ((k, v) in detail) line.put(k, v ?: JSONObject.NULL)
    line.put("atMs", System.currentTimeMillis())
    line.put("event", event)
    line.put("pid", Process.myPid())
    Log.i("HsnS5", line.toString())
    File(context.filesDir, "app.jsonl").appendText(line.toString() + "\n")
  }

  private fun prefs(context: Context) = context.getSharedPreferences("hsn.push", Context.MODE_PRIVATE)

  fun storeKey(context: Context, keyIdHex: String, keyB64url: String) {
    prefs(context).edit().putString("key.$keyIdHex", keyB64url).commit()
  }

  fun createChannels(context: Context): Map<String, Any?> {
    val nm = context.getSystemService(NotificationManager::class.java)
    val alarm = NotificationChannel(CRITICAL, "Alarms and countdowns", NotificationManager.IMPORTANCE_HIGH)
    alarm.setBypassDnd(true)
    alarm.setSound(
      RingtoneManager.getDefaultUri(RingtoneManager.TYPE_ALARM),
      AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_ALARM)
        .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION).build(),
    )
    alarm.lockscreenVisibility = Notification.VISIBILITY_PUBLIC
    nm.createNotificationChannel(alarm)
    nm.createNotificationChannel(NotificationChannel(ORDINARY, "Other notifications", NotificationManager.IMPORTANCE_DEFAULT))
    nm.createNotificationChannel(NotificationChannel(OUTCOME, "Disarm results", NotificationManager.IMPORTANCE_HIGH))
    val made = nm.getNotificationChannel(CRITICAL)
    return mapOf("criticalImportance" to made.importance, "criticalBypassDnd" to made.canBypassDnd())
  }

  sealed class Opened {
    data class Ok(val content: JSONObject) : Opened()
    data class Refused(val why: String) : Opened()
  }

  fun open(context: Context, h: String): Opened {
    val parts = h.split(".")
    if (parts.size != 3 || parts[0] != "1" || !Regex("^[0-9a-f]{16}$").matches(parts[1]) ||
      !Regex("^[A-Za-z0-9_-]{1744}$").matches(parts[2])) return Opened.Refused("badFormat")
    val fixture = File(context.filesDir, "provision.json")
    val record = if (fixture.exists()) JSONObject(fixture.readText()) else null
    val keyText = if (record?.optString("pushKeyId") == parts[1]) record.getString("pushKey")
      else prefs(context).getString("key.${parts[1]}", null) ?: return Opened.Refused("unknownKey")
    val key = Base64.decode(keyText, Base64.URL_SAFE or Base64.NO_PADDING or Base64.NO_WRAP)
    val sealed = Base64.decode(parts[2], Base64.URL_SAFE or Base64.NO_PADDING or Base64.NO_WRAP)
    if (key.size != 32 || sealed.size != 12 + 1280 + 16) return Opened.Refused("badFormat")
    val keyId = parts[1].chunked(2).map { it.toInt(16).toByte() }.toByteArray()
    val aad = "hsn-push/1".toByteArray() + byteArrayOf(0) + keyId
    val plain = try {
      val cipher = Cipher.getInstance("ChaCha20-Poly1305")
      cipher.init(Cipher.DECRYPT_MODE, SecretKeySpec(key, "ChaCha20"), IvParameterSpec(sealed, 0, 12))
      cipher.updateAAD(aad)
      cipher.doFinal(sealed, 12, sealed.size - 12)
    } catch (e: Exception) {
      return Opened.Refused("decryptFailed")
    }
    val last = plain.indexOfLast { it != 0.toByte() }
    if (last < 0 || plain[last] != 0x80.toByte()) return Opened.Refused("badPadding")
    return try {
      val c = JSONObject(String(plain, 0, last, Charsets.UTF_8))
      if (c.optInt("v") != 1 || !c.has("hub") || !c.has("n")) Opened.Refused("badContent") else Opened.Ok(c)
    } catch (e: Exception) {
      Opened.Refused("badContent")
    }
  }

  private fun asset(context: Context, name: String): JSONObject =
    JSONObject(context.assets.open(name).bufferedReader().readText())

  private fun word(common: JSONObject, path: String, values: Map<String, String> = emptyMap()): String? {
    var node: Any? = common
    for (part in path.split(".")) node = (node as? JSONObject)?.opt(part)
    var text = node as? String ?: return null
    for ((k, v) in values) text = text.replace("{{$k}}", v)
    return text
  }

  fun words(context: Context, c: JSONObject): Pair<String, String> {
    val common = asset(context, "common.json")
    val pushWords = asset(context, "push-words.json")
    val n = c.getJSONObject("n")
    val kind = n.optString("kind")
    if (kind == "hub_unreachable" || kind == "hub_back")
      return Pair(pushWords.optString("$kind.title"), pushWords.optString("$kind.text"))
    val category = n.optString("category")
    val what = word(common, "notifications.category.$category") ?: pushWords.optString("unknown")
    val title = word(common, "banner.$category") ?: what
    var body = what
    val device = c.optJSONObject("names")?.optString("device", "") ?: ""
    if (device.isNotEmpty()) body = word(common, "notifications.about", mapOf("what" to what, "device" to device)) ?: body
    if (c.optBoolean("delayed")) body += " " + (word(common, "notifications.delayed") ?: "")
    return Pair(title, body)
  }

  /** FCM's `data` (or the stand-in's): opens it and posts the notification. */
  fun onMessage(context: Context, data: Map<String, String>, via: String) {
    val receivedMs = System.currentTimeMillis()
    journal(context, "android.message", mapOf("via" to via))
    val h = data["h"] ?: return journal(context, "android.noH")
    val opened = open(context, h)
    if (opened is Opened.Refused) {
      // Nothing is shown for a push this phone cannot open (m4-design section 3).
      return journal(context, "android.refused", mapOf("why" to opened.why))
    }
    val c = (opened as Opened.Ok).content
    createChannels(context)
    val n = c.getJSONObject("n")
    val hub = c.getString("hub")
    val kind = n.optString("kind")
    val category = n.optString("category")
    val device = if (n.isNull("device")) -1 else n.optInt("device", -1)
    val p = prefs(context)
    val lastArmed = p.getBoolean("armed.$hub", false)
    val critical = n.optBoolean("critical") || (kind == "hub_unreachable" && lastArmed)
    if (kind != "hub_unreachable" && kind != "hub_back") p.edit().putBoolean("armed.$hub", c.optBoolean("armed")).commit()
    val (title, body) = words(context, c)
    val nm = context.getSystemService(NotificationManager::class.java)
    val builder = Notification.Builder(context, if (critical) CRITICAL else ORDINARY)
      .setSmallIcon(android.R.drawable.ic_lock_idle_alarm)
      .setContentTitle(title)
      .setContentText(body)
      .setVisibility(Notification.VISIBILITY_PUBLIC)
      .setAutoCancel(false)
    if (critical) builder.setCategory(Notification.CATEGORY_ALARM)
    val actions = c.optJSONArray("actions")
    if (actions != null && (0 until actions.length()).any { actions.optString(it) == "disarm" }) {
      val intent = Intent(context, DisarmActionReceiver::class.java)
        .putExtra("hub", hub).putExtra("device", device).putExtra("seq", n.optLong("seq"))
      val pending = PendingIntent.getBroadcast(
        context, (hub + device).hashCode(), intent, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
      )
      builder.addAction(Notification.Action.Builder(null, asset(context, "push-words.json").optString("disarm"), pending).build())
    }
    val id = when (category) {
      "countdown" -> 100_000 + device
      "alarm" -> 200_000 + device
      else -> (n.optLong("seq") % 1_000_000).toInt()
    }
    if (category == "alarm" && device >= 0) {
      val before = nm.activeNotifications.count { it.tag == hub && it.id == 100_000 + device }
      nm.cancel(hub, 100_000 + device)
      journal(context, "android.replace", mapOf("countdownsShown" to before))
    }
    nm.notify(hub, id, builder.build())
    journal(context, "android.posted", mapOf(
      "kind" to kind, "title" to title, "body" to body, "channel" to if (critical) CRITICAL else ORDINARY,
      "ms" to System.currentTimeMillis() - receivedMs, "interruptionFilter" to nm.currentInterruptionFilter,
    ))
  }

  fun postOutcome(context: Context, text: String) {
    createChannels(context)
    val nm = context.getSystemService(NotificationManager::class.java)
    nm.notify("outcome", 1, Notification.Builder(context, OUTCOME)
      .setSmallIcon(android.R.drawable.ic_lock_idle_lock).setContentText(text).build())
  }
}

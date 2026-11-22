// Spike S5: the app's side of the `push` module on Android. Throwaway. Mirrors the iOS module's
// functions where they mean something here.
package expo.modules.hsnpush

import android.app.ActivityManager
import android.app.NotificationManager
import android.content.Context
import android.content.Intent
import android.provider.Settings
import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import org.json.JSONObject
import java.io.File

class HsnPushModule : Module() {
  private val context: Context get() = requireNotNull(appContext.reactContext)

  private fun state(): String {
    val info = ActivityManager.RunningAppProcessInfo()
    ActivityManager.getMyMemoryState(info)
    return if (info.importance <= ActivityManager.RunningAppProcessInfo.IMPORTANCE_FOREGROUND) "foreground" else "background(${info.importance})"
  }

  private fun toMap(json: JSONObject): Map<String, Any?> =
    json.keys().asSequence().associateWith { k -> json.opt(k).takeUnless { it == JSONObject.NULL } }

  override fun definition() = ModuleDefinition {
    Name("HsnPush")
    Events("onDisarm")

    OnCreate { Push.journal(context, "app.module.create", mapOf("state" to state())) }

    Function("log") { event: String, detail: Map<String, Any?> -> Push.journal(context, event, detail) }
    Function("appState") { state() }

    Function("provision") {
      val file = File(context.filesDir, "provision.json")
      if (!file.exists()) mapOf("ok" to false) else (toMap(JSONObject(file.readText())) - "pushKey") + ("ok" to true)
    }

    Function("storeTestKey") { keyIdHex: String, keyB64url: String ->
      Push.storeKey(context, keyIdHex, keyB64url)
      0
    }

    Function("setArmed") { hub: String, armed: Boolean ->
      context.getSharedPreferences("hsn.push", Context.MODE_PRIVATE).edit().putBoolean("armed.$hub", armed).commit()
    }

    Function("nextSeq") { floor: Int ->
      val p = context.getSharedPreferences("hsn.push", Context.MODE_PRIVATE)
      val next = maxOf(p.getInt("seq", 0), floor) + 1
      p.edit().putInt("seq", next).commit()
      next
    }

    Function("pendingDisarm") { null as Map<String, Any?>? }

    AsyncFunction("finishDisarm") { ok: Boolean, text: String, promise: Promise ->
      Push.postOutcome(context, text)
      Push.journal(context, "app.disarm.outcome", mapOf("ok" to ok))
      promise.resolve(null)
    }

    Function("createChannels") { Push.createChannels(context) }

    AsyncFunction("delivered") { promise: Promise ->
      val nm = context.getSystemService(NotificationManager::class.java)
      promise.resolve(nm.activeNotifications.map {
        mapOf("tag" to it.tag, "id" to it.id, "channel" to it.notification.channelId,
          "title" to it.notification.extras.getString("android.title"),
          "text" to it.notification.extras.getCharSequence("android.text")?.toString(),
          "category" to it.notification.category, "actions" to (it.notification.actions?.size ?: 0))
      })
    }

    AsyncFunction("settings") { promise: Promise ->
      val nm = context.getSystemService(NotificationManager::class.java)
      val ch = nm.getNotificationChannel(Push.CRITICAL)
      promise.resolve(mapOf(
        "enabled" to nm.areNotificationsEnabled(),
        "interruptionFilter" to nm.currentInterruptionFilter,
        "policyAccess" to nm.isNotificationPolicyAccessGranted,
        "criticalImportance" to ch?.importance,
        "criticalBypassDnd" to ch?.canBypassDnd(),
        "policy" to if (nm.isNotificationPolicyAccessGranted) nm.notificationPolicy.toString() else null,
      ))
    }

    Function("askPolicyAccess") {
      val i = Intent(Settings.ACTION_NOTIFICATION_POLICY_ACCESS_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      context.startActivity(i)
      "opened"
    }

    Function("journals") {
      mapOf("app.jsonl" to File(context.filesDir, "app.jsonl").let { if (it.exists()) it.readText() else "" })
    }
  }
}

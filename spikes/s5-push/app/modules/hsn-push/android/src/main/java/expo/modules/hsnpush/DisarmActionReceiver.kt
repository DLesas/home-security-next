// Spike S5, step 4: the notification's Disarm. Starts React Native's headless JavaScript
// (DisarmTaskService), which runs the same `runDisarm` as iOS.
package expo.modules.hsnpush

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import com.facebook.react.HeadlessJsTaskService

class DisarmActionReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    val tapMs = System.currentTimeMillis()
    Push.journal(context, "android.disarm.action", mapOf("tapMs" to tapMs, "device" to intent.getIntExtra("device", -1)))
    val service = Intent(context, DisarmTaskService::class.java)
      .putExtra("tapMs", tapMs.toDouble())
      .putExtra("hub", intent.getStringExtra("hub"))
      .putExtra("device", intent.getIntExtra("device", -1))
    try {
      context.startService(service)
      HeadlessJsTaskService.acquireWakeLockNow(context)
      Push.journal(context, "android.disarm.serviceStarted")
    } catch (e: Exception) {
      Push.journal(context, "android.disarm.serviceRefused", mapOf("error" to e.toString()))
    }
  }
}

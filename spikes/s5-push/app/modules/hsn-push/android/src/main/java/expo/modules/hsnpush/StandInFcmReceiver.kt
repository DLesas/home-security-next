// Local-only injector. Route a data-only intent through the installed service resolver.
package expo.modules.hsnpush

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import com.google.firebase.messaging.FcmBroadcastProcessor

class StandInFcmReceiver : BroadcastReceiver() {
  /** Hold the broadcast until the selected messaging service has handled the local data. */
  override fun onReceive(context: Context, intent: Intent) {
    val h = intent.getStringExtra("h") ?: return
    val pending = goAsync()
    FcmBroadcastProcessor(context.applicationContext)
      .process(Intent(HsnMessagingService.LOCAL_DATA).putExtra("h", h))
      .addOnCompleteListener { pending.finish() }
  }
}

package app.hsn.push

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import com.google.firebase.messaging.FcmBroadcastProcessor
import com.google.firebase.messaging.RemoteMessage

/** Emulator shell stand-in. Bind to the same selected service as incoming FCM data. */
class LocalDelivery : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    val sealed = intent.getStringExtra("h") ?: return
    val pending = goAsync()
    FcmBroadcastProcessor(context.applicationContext)
      .process(Intent(LOCAL).putExtra("h", sealed))
      .addOnCompleteListener { pending.finish() }
  }
}

private const val LOCAL = "app.hsn.push.LOCAL"

/** Development-only conversion of the stand-in intent into the real service's data callback. */
class MessagingService : SealedMessagingService() {
  override fun handleIntent(intent: Intent) {
    if (intent.action != LOCAL) return super.handleIntent(intent)
    val h = intent.getStringExtra("h") ?: return
    onMessageReceived(RemoteMessage.Builder("local").addData("h", h).build())
  }
}

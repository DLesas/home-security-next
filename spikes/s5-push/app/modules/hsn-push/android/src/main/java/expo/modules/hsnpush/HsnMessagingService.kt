// A local intent reaches this OS-created service without invoking Google's delivery/ack path.
package expo.modules.hsnpush

import android.content.Intent
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage

class HsnMessagingService : FirebaseMessagingService() {
  companion object { const val LOCAL_DATA = "invalid.hsn.s5.LOCAL_DATA" }

  /** Adapt the local stand-in to the same data callback as a delivered message. */
  override fun handleIntent(intent: Intent) {
    if (intent.action != LOCAL_DATA) return super.handleIntent(intent)
    val h = intent.getStringExtra("h") ?: return
    onMessageReceived(RemoteMessage.Builder("local").addData("h", h).build())
  }

  /** Open and display the sealed payload in the messaging service. */
  override fun onMessageReceived(message: RemoteMessage) {
    Push.onMessage(this, message.data, javaClass.simpleName)
  }
}

package app.hsn.push

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import com.google.firebase.messaging.FcmBroadcastProcessor

/** Emulator shell stand-in. Bind to the same selected service as incoming FCM data. */
class LocalDelivery : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val sealed = intent.getStringExtra("h") ?: return
        val pending = goAsync()
        FcmBroadcastProcessor(context.applicationContext)
            .process(Intent(MessagingService.LOCAL).putExtra("h", sealed))
            .addOnCompleteListener { pending.finish() }
    }
}

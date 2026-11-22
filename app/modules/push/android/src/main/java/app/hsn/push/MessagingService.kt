package app.hsn.push

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.media.AudioAttributes
import android.media.RingtoneManager
import com.google.firebase.messaging.RemoteMessage
import expo.modules.notifications.service.ExpoFirebaseMessagingService

/** Retains Expo's token callback while owning all sealed data delivery. */
open class SealedMessagingService : ExpoFirebaseMessagingService() {
    override fun onMessageReceived(remoteMessage: RemoteMessage) { remoteMessage.data["h"]?.let { receive(it) } }

    /** Authenticate and serialize with home removal and foreground updates before showing anything. */
    private fun receive(h: String) {
        if (android.os.Build.VERSION.SDK_INT < 28) return
        val store = PushStore.of(this)
        val words = wordsFor(this)
        runCatching { store.transaction {
            val alert = Envelope.open(h, store::lookup, ::fields, words.categoryNames) ?: return@transaction
            store.deliver(alert) { decision ->
                val nm = channels(this,words)
                val (title,body) = words.text(alert,store.prefix(alert.hub),System.currentTimeMillis())
                val builder = Notification.Builder(this,if(decision.critical) "critical" else "ordinary")
                    .setSmallIcon(android.R.drawable.ic_lock_idle_alarm).setContentTitle(title).setContentText(body)
                    .setStyle(Notification.BigTextStyle().bigText(body)).setVisibility(Notification.VISIBILITY_PUBLIC)
                if(decision.critical) builder.setCategory(Notification.CATEGORY_ALARM)
                addAction(this,builder,alert,decision.tag,words)
                decision.cancel?.let { nm.cancel(it,1) }
                nm.notify(decision.tag,1,builder.build())
            }
        } }.onFailure { failure ->
            if (applicationInfo.flags and android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE != 0)
                android.util.Log.w("HomePush","Delivery failed: " + failure.javaClass.simpleName)
        }
    }
}

/** Creates stable channels; Android retains the user's sound and DND choices across calls. */
internal fun channels(context: Context, words: AlertWords): NotificationManager {
    val nm = context.getSystemService(NotificationManager::class.java)
    val loud = NotificationChannel("critical",words.word("criticalChannel"),NotificationManager.IMPORTANCE_HIGH)
    loud.setBypassDnd(true)
    loud.setSound(RingtoneManager.getDefaultUri(RingtoneManager.TYPE_ALARM),AudioAttributes.Builder()
        .setUsage(AudioAttributes.USAGE_ALARM).setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION).build())
    nm.createNotificationChannels(listOf(loud,
        NotificationChannel("ordinary",words.word("ordinaryChannel"),NotificationManager.IMPORTANCE_DEFAULT),
        NotificationChannel("outcome",words.word("outcomeChannel"),NotificationManager.IMPORTANCE_HIGH)))
    return nm
}

package app.hsn.push

import android.app.Notification
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.Log
import com.facebook.react.HeadlessJsTaskService
import com.facebook.react.bridge.Arguments
import com.facebook.react.jstasks.HeadlessJsTaskConfig

/** Binds a single immutable notification action to the alert's own home and posted tag. */
internal fun addAction(context: Context, builder: Notification.Builder, alert: Alert, tag: String, words: AlertWords) {
    val action = alert.action ?: return
    val flags = PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
    val pending = if (action == "armAway") {
        val activity = context.packageManager.getLaunchIntentForPackage(context.packageName) ?: return
        activity.action = Intent.ACTION_VIEW
        activity.data = Uri.parse("hsn:///")
        PendingIntent.getActivity(context,0,activity,flags)
    } else {
        val intent = Intent(context,DisarmTap::class.java)
            .setData(Uri.Builder().scheme("hsn-action").authority("disarm").appendPath(tag).appendPath(alert.seq.toString()).build())
            .putExtra("hub",alert.hub).putExtra("tag",tag)
        PendingIntent.getBroadcast(context,0,intent,flags)
    }
    builder.addAction(Notification.Action.Builder(null,words.word(action),pending).build())
}

/** Keeps a deadline from native receipt; an expired JS task still leaves an actionable outcome. */
internal object Outcomes {
    private data class Pending(val wall: Long, val steady: Long, val timeout: Runnable)
    private val pending = mutableMapOf<String,Pending>()
    private val handler = Handler(Looper.getMainLooper())

    /** Arms a fallback before asking Android to start React Native. */
    @Synchronized fun begin(context: Context, tag: String): Long {
        val wall = System.currentTimeMillis()
        pending.remove(tag)?.let { handler.removeCallbacks(it.timeout) }
        val timeout = Runnable { finish(context,tag,wall,false) }
        pending[tag] = Pending(wall,SystemClock.elapsedRealtime(),timeout)
        handler.postDelayed(timeout,30000)
        return wall
    }

    /** Replaces the tapped notification and records only duration and success on a debug installation. */
    @Synchronized fun finish(context: Context, tag: String, wall: Long, ok: Boolean) {
        val tap = pending[tag]?.takeIf { it.wall == wall } ?: return
        pending.remove(tag)
        handler.removeCallbacks(tap.timeout)
        val words = wordsFor(context)
        val nm = channels(context,words)
        nm.cancel(tag,1)
        nm.notify(tag,1,Notification.Builder(context,"outcome").setSmallIcon(android.R.drawable.ic_lock_idle_lock)
            .setContentText(words.word(if(ok) "succeeded" else "failed")).setAutoCancel(true).build())
        if (context.applicationInfo.flags and android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE != 0)
            Log.i("HomePush","outcome ok=$ok elapsedMs=${SystemClock.elapsedRealtime()-tap.steady}")
    }
}

/** An OS-dispatched button tap starts JS without starting an activity or checking the app lock. */
class DisarmTap : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val hub = intent.getStringExtra("hub") ?: return
        val tag = intent.getStringExtra("tag") ?: return
        val wall = Outcomes.begin(context.applicationContext,tag)
        runCatching {
            context.startService(Intent(context,DisarmTask::class.java)
                .putExtra("hub",hub).putExtra("tag",tag).putExtra("tapMs",wall.toDouble()))
            HeadlessJsTaskService.acquireWakeLockNow(context)
        }.onFailure { Outcomes.finish(context,tag,wall,false) }
    }
}

/** Android's background entry into the product JS bundle. */
class DisarmTask : HeadlessJsTaskService() {
    override fun getTaskConfig(intent: Intent?) = intent?.extras?.let {
        HeadlessJsTaskConfig("HomePushDisarm", Arguments.fromBundle(it),30000,true)
    }
}

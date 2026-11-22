// Spike S5: React Native's headless JS for the Disarm action; the task `HsnDisarm` is registered in
// the spike's index.js. 30 s at most.
package expo.modules.hsnpush

import android.content.Intent
import com.facebook.react.HeadlessJsTaskService
import com.facebook.react.bridge.Arguments
import com.facebook.react.jstasks.HeadlessJsTaskConfig

class DisarmTaskService : HeadlessJsTaskService() {
  override fun getTaskConfig(intent: Intent?): HeadlessJsTaskConfig? {
    val extras = intent?.extras ?: return null
    Push.journal(this, "android.disarm.taskConfig")
    return HeadlessJsTaskConfig("HsnDisarm", Arguments.fromBundle(extras), 30_000, true)
  }
}

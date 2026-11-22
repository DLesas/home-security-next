package app.hsn.push

import android.content.Context
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/** Thin bridge to the same app-private records used without JavaScript by MessagingService. */
class PushModule : Module() {
  private val context: Context
    get() = requireNotNull(appContext.reactContext)

  private val store
    get() = PushStore.of(context)

  override fun definition() = ModuleDefinition {
    Name("HomePush")
    Constant("configured") {
      val id = context.resources.getIdentifier("google_app_id", "string", context.packageName)
      android.os.Build.VERSION.SDK_INT >= 28 && id != 0 && context.getString(id).isNotBlank()
    }
    AsyncFunction("finish") { tag: String, tapMs: Double, ok: Boolean ->
      Outcomes.finish(context, tag, tapMs.toLong(), ok)
    }
    AsyncFunction("keys") { hub: String -> store.keys(hub) }
    AsyncFunction("writeKeys") { hub: String, keys: Map<String, Any?> -> store.put(hub, keys) }
    AsyncFunction("arm") { hub: String, armed: Boolean -> store.arm(hub, armed) }
    AsyncFunction("homes") { names: Map<String, String> -> store.homes(names) }
    AsyncFunction("remove") { hub: String -> store.remove(hub) }
  }
}

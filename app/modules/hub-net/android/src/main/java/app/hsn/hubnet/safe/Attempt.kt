// The one place hub-net's Kotlin catches (the repository's rule: `try` only in a `safe` folder).
// NsdManager throws IllegalArgumentException for a listener it does not know or already holds,
// and Expo's permission service throws IllegalStateException with no activity or while another
// request is open. An exception escaping a callback on the module's own thread would end the app,
// so every such call goes through here and its failure becomes an answer.
package app.hsn.hubnet.safe

/** Runs `call`; its value, or null if it threw. */
internal inline fun <T> attempt(call: () -> T): T? =
  try {
    call()
  } catch (_: RuntimeException) {
    null
  }

/** Runs `call`; whether it returned without throwing. */
internal inline fun attempted(call: () -> Unit): Boolean = attempt(call) != null

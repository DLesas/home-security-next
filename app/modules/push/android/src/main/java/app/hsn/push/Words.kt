package app.hsn.push

import android.content.Context
import java.text.DateFormat
import java.util.Date
import java.util.Locale

/** Loads the app's local translations, including in a fresh service process with no JS runtime. */
internal fun wordsFor(context: Context): AlertWords {
  val locale = context.resources.configuration.locales[0] ?: Locale.ENGLISH
  val languages = listOf(locale.toLanguageTag(), locale.language, "en").distinct()
  /** Tries each language before falling back to English for a missing resource. */
  fun load(name: String): Fields =
    languages.firstNotNullOf { language ->
      runCatching {
          context.assets.open("push/$language/$name.json").bufferedReader().use {
            fields(it.readText())
          }
        }
        .getOrNull()
    }
  val clock = DateFormat.getTimeInstance(DateFormat.SHORT, locale)
  return AlertWords(load("common"), load("push")) { clock.format(Date(it)) }
}

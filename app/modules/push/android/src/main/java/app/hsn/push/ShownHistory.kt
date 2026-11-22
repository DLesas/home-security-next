package app.hsn.push

/** SQLite runs the trigger in the same transaction as the delivery that inserted the sequence. */
internal object ShownHistory {
  const val table = "CREATE TABLE shown(hub TEXT, seq INTEGER, PRIMARY KEY(hub,seq)) WITHOUT ROWID"
  private const val retained = 500

  /** The composite primary key finds the first sequence outside this home's window. */
  private fun prune(hub: String) =
    """
        DELETE FROM shown WHERE hub = $hub AND seq <= (
            SELECT seq FROM shown WHERE hub = $hub ORDER BY seq DESC LIMIT 1 OFFSET $retained
        )
    """
      .trimIndent()

  val trigger = "CREATE TRIGGER limit_shown AFTER INSERT ON shown BEGIN ${prune("NEW.hub")}; END"
  val pruneExisting = prune("?1")
}

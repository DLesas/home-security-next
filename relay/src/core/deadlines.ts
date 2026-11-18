/**
 * The times the presence core asked to be woken at, per hub: a binary heap of `(at, key)`. One
 * entry per key: `set` replaces a key's time, so a hub heard every 30 s keeps one entry, and the
 * shell's timer runs only for the earliest. Pure data; no clock.
 */
export class Deadlines {
  private heap: { at: number; key: string }[] = [];
  private readonly index = new Map<string, number>();

  /** Sets `key`'s time, or removes it with null. */
  set(key: string, at: number | null): void {
    const where = this.index.get(key);
    if (at === null) {
      if (where !== undefined) this.removeAt(where);
      return;
    }
    if (where === undefined) {
      this.heap.push({ at, key });
      this.index.set(key, this.heap.length - 1);
      this.up(this.heap.length - 1);
      return;
    }
    const entry = this.heap[where];
    if (entry === undefined) return;
    const earlier = at < entry.at;
    entry.at = at;
    if (earlier) this.up(where);
    else this.down(where);
  }

  /** The earliest time, or null when nothing waits. */
  get next(): number | null {
    return this.heap[0]?.at ?? null;
  }

  /** Removes and returns every key due at `nowMs`, earliest first. */
  takeDue(nowMs: number): string[] {
    const due: string[] = [];
    for (;;) {
      const top = this.heap[0];
      if (top === undefined || top.at > nowMs) break;
      due.push(top.key);
      this.removeAt(0);
    }
    return due;
  }

  get size(): number {
    return this.heap.length;
  }

  private removeAt(where: number): void {
    const last = this.heap.pop();
    const gone = this.heap[where] ?? last;
    if (gone !== undefined) this.index.delete(gone.key);
    if (last === undefined || where >= this.heap.length) return;
    this.heap[where] = last;
    this.index.set(last.key, where);
    this.up(where);
    this.down(where);
  }

  private swap(a: number, b: number): void {
    const x = this.heap[a];
    const y = this.heap[b];
    if (x === undefined || y === undefined) return;
    this.heap[a] = y;
    this.heap[b] = x;
    this.index.set(y.key, a);
    this.index.set(x.key, b);
  }

  private up(at: number): void {
    let i = at;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if ((this.heap[parent]?.at ?? 0) <= (this.heap[i]?.at ?? 0)) break;
      this.swap(i, parent);
      i = parent;
    }
  }

  private down(at: number): void {
    let i = at;
    for (;;) {
      const left = 2 * i + 1;
      const right = left + 1;
      let least = i;
      if (left < this.heap.length && (this.heap[left]?.at ?? 0) < (this.heap[least]?.at ?? 0))
        least = left;
      if (right < this.heap.length && (this.heap[right]?.at ?? 0) < (this.heap[least]?.at ?? 0))
        least = right;
      if (least === i) break;
      this.swap(i, least);
      i = least;
    }
  }
}

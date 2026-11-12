"""Gateway load simulation: many sensors sharing one site channel and one half-duplex gateway radio.

Models: random heartbeats (+-10%), Poisson door events, link-check replies at a fixed moment,
event replies sent as soon as the radio is free, sensor retries, optional listen-before-send
with hidden sensors, and a siren's LoRa checks. Two overlapping packets on the site channel are
both lost (no capture effect), and the gateway hears nothing while it transmits. Conservative.
"""
import heapq, math, random, sys, json

def toa(sf, n=25, bw=125.0):
    ldro = sf >= 11
    ts = (2 ** sf) / bw / 1000.0
    num = 8 * n - 4 * sf + 44
    den = 4 * (sf - 2 * ldro)
    return (8 + 12.25 + max(math.ceil(num / den), 0) * 5) * ts

def run(n, sf, hb, days=60, events_per_day=20, cad=False, hidden=0.3, link_every=5,
        reply_delay=1.0, rtt=(0.05, 0.3), event_timeout=None, siren_sf=None, seed=1,
        reply_sf=None, slots=False, slot_drift=1.0):
    rnd = random.Random(seed)
    up, down = toa(sf), toa(reply_sf or sf)
    event_timeout = event_timeout or (0.3 + 2 * down + 1.0)   # covers a busy gateway once
    T = days * 86400.0
    q, seq = [], 0
    def push(t, kind, **kw):
        nonlocal seq; seq += 1; heapq.heappush(q, (t, seq, kind, kw))
    uplinks = []          # [start, end, sender]
    active_up = []        # indexes of uplinks possibly in progress
    gw_tx = []            # [start, end]
    gw_busy_until = 0.0
    stats = dict(up=0, up_lost=0, hb=0, hb_lost=0, lc=0, lc_lost=0, ev=0, ev_unanswered=0,
                 first_try=0, gw_air=0.0)
    lat = []
    heard = {i: [] for i in range(n)}
    ev_state = {}         # event id -> dict
    for i in range(n):
        push((i * hb / n) if slots else rnd.uniform(0, hb), "hb", s=i, k=0)
        push(rnd.expovariate(events_per_day / 86400.0), "event", s=i)
    if siren_sf:
        push(rnd.uniform(0, 300), "siren", s=-1)

    def radio_busy(t):
        if t < gw_busy_until: return True
        return any(uplinks[j][0] <= t < uplinks[j][1] for j in active_up)

    def start_up(t, s, length, meta):
        uplinks.append([t, t + length, s]); idx = len(uplinks) - 1
        active_up.append(idx)
        push(t + length, "up_end", idx=idx, meta=meta)

    def try_send(t, s, length, meta, tries=0):
        if cad and tries < 5:
            busy = [j for j in active_up if uplinks[j][0] <= t < uplinks[j][1] and uplinks[j][2] != s]
            if busy and rnd.random() > hidden:
                push(t + rnd.uniform(0.2, 2.0) + length * rnd.random(), "retry_send", s=s, length=length, meta=meta, tries=tries + 1)
                return
        start_up(t, s, length, meta)

    def gw_send(t, length):
        nonlocal gw_busy_until
        gw_tx.append([t, t + length]); gw_busy_until = t + length
        stats["gw_air"] += length
        return t + length

    while q:
        t, _, kind, kw = heapq.heappop(q)
        if t > T: break
        active_up[:] = [j for j in active_up if uplinks[j][1] > t - 5]
        if kind == "hb":
            s, k = kw["s"], kw["k"]
            stats["hb"] += 1
            try_send(t, s, up, dict(type="hb", link=(k % link_every == 0)))
            if slots:  # hub-assigned slot; clock drift left after correction, at random
                push(s * hb / n + (k + 1) * hb + rnd.uniform(-slot_drift, slot_drift), "hb", s=s, k=k + 1)
            else:
                push(t + hb * rnd.uniform(0.9, 1.1), "hb", s=s, k=k + 1)
        elif kind == "siren":
            try_send(t, -1, toa(siren_sf, 28), dict(type="siren"))
            push(t + 300, "siren", s=-1)
        elif kind == "event":
            s = kw["s"]; eid = (s, t)
            stats["ev"] += 1
            ev_state[eid] = dict(t0=t, done=False, attempt=0)
            try_send(t, s, up, dict(type="ev", eid=eid, attempt=0))
            push(t + rnd.expovariate(events_per_day / 86400.0), "event", s=s)
        elif kind == "retry_send":
            try_send(t, kw["s"], kw["length"], kw["meta"], kw["tries"])
        elif kind == "up_end":
            st, en, s = uplinks[kw["idx"]]
            meta = kw["meta"]
            lost = any(j != kw["idx"] and uplinks[j][0] < en and uplinks[j][1] > st for j in active_up) \
                or any(a < en and b > st for a, b in gw_tx[-6:])
            if s >= 0:
                stats["up"] += 1; stats["up_lost"] += lost
                if not lost: heard[s].append(en)
            if meta["type"] == "hb":
                if lost: stats["hb_lost"] += 1
                if meta["link"]:
                    stats["lc"] += 1
                    if lost: stats["lc_lost"] += 1
                    else: push(en + reply_delay, "slot_reply", s=s)
            elif meta["type"] == "ev":
                eid = meta["eid"]
                if not lost:
                    push(en + rnd.uniform(*rtt), "ev_reply", s=s, eid=eid, deadline=en + event_timeout - down, attempt=meta["attempt"])
                push(en + event_timeout, "ev_check", s=s, eid=eid, attempt=meta["attempt"])
        elif kind == "slot_reply":
            if radio_busy(t): stats["lc_lost"] += 1
            else: gw_send(t, down)
        elif kind == "ev_reply":
            es = ev_state[kw["eid"]]
            if es["done"] or kw["attempt"] != es["attempt"]: continue
            if t > kw["deadline"]: continue
            if radio_busy(t):
                nxt = max([gw_busy_until] + [uplinks[j][1] for j in active_up if uplinks[j][0] <= t < uplinks[j][1]])
                push(nxt + 0.005, "ev_reply", **kw)
            else:
                end = gw_send(t, down)
                es["done"] = True
                lat.append(end - es["t0"])
                if es["attempt"] == 0: stats["first_try"] += 1
        elif kind == "ev_check":
            es = ev_state[kw["eid"]]
            if es["done"] or kw["attempt"] != es["attempt"]: continue
            offsets = [2, 5, 10] + [10 + 60 * i for i in range(1, 11)]
            a = es["attempt"] + 1
            if a > len(offsets) or es["t0"] + offsets[a - 1] > es["t0"] + 600:
                stats["ev_unanswered"] += 1; es["done"] = True; continue
            es["attempt"] = a
            prev = offsets[a - 2] if a >= 2 else 0
            at = max(t, es["t0"] + offsets[a - 1] + rnd.uniform(0, 0.5 * (offsets[a - 1] - prev)))  # random extra wait
            push(at, "retry_send", s=kw["s"], length=up, meta=dict(type="ev", eid=kw["eid"], attempt=a), tries=0)

    lat.sort()
    pct = lambda p: lat[min(len(lat) - 1, int(p * len(lat)))] if lat else float("nan")
    silent = {}
    for k in (3, 4, 5, 6):
        c = 0
        for s, times in heard.items():
            for a, b in zip(times, times[1:]):
                if b - a > k * hb * 1.1: c += 1
        silent[k] = c * 365 / days
    return dict(
        sensors=n, sf=sf, heartbeat_min=hb / 60, cad=cad, reply_sf=reply_sf or sf, slots=slots,
        uplink_lost_pct=round(100 * stats["up_lost"] / max(stats["up"], 1), 2),
        link_check_reply_lost_pct=round(100 * stats["lc_lost"] / max(stats["lc"], 1), 2),
        door_reply_first_try_pct=round(100 * stats["first_try"] / max(stats["ev"], 1), 2),
        door_unanswered_after_10min=stats["ev_unanswered"],
        door_reply_s_median=round(pct(0.5), 2), door_reply_s_p99=round(pct(0.99), 2), door_reply_s_max=round(lat[-1], 2) if lat else None,
        gateway_tx_pct_of_hour=round(100 * stats["gw_air"] / T, 2),
        false_silent_per_year={f"after {k} missed": round(v, 1) for k, v in silent.items()},
    )

if __name__ == "__main__":
    scen = [
        dict(n=10, sf=12, hb=300), dict(n=10, sf=12, hb=300, cad=True),
        dict(n=10, sf=10, hb=180), dict(n=10, sf=10, hb=180, cad=True),
        dict(n=30, sf=7, hb=180), dict(n=30, sf=7, hb=180, cad=True),
        dict(n=20, sf=10, hb=180, cad=True),
    ]
    days = int(sys.argv[1]) if len(sys.argv) > 1 else 60
    for sc in scen:
        print(json.dumps(run(**sc, days=days, siren_sf=10)))

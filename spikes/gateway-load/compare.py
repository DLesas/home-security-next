# Compares ways to cut collisions, one simulated year each.
import json, sys
from simulate import run
cases = [
    ("10 sensors at SF12", dict(n=10, sf=12, hb=300)),
    ("20 sensors at SF10", dict(n=20, sf=10, hb=180)),
    ("30 sensors at SF7", dict(n=30, sf=7, hb=180)),
]
variants = [
    ("listen first (current spec)", dict(cad=True)),
    ("+ faster replies", dict(cad=True, faster=True)),
    ("+ heartbeat slots", dict(cad=True, slots=True)),
    ("+ both", dict(cad=True, faster=True, slots=True)),
]
for cname, c in cases:
    for vname, v in variants:
        kw = dict(c, cad=v["cad"], slots=v.get("slots", False), days=365, siren_sf=10)
        if v.get("faster"): kw["reply_sf"] = max(7, c["sf"] - 3)
        r = run(**kw)
        f = r["false_silent_per_year"]
        print(json.dumps(dict(case=cname, variant=vname, lost=r["uplink_lost_pct"], lc_lost=r["link_check_reply_lost_pct"],
              first=r["door_reply_first_try_pct"], med=r["door_reply_s_median"], p99=r["door_reply_s_p99"],
              worst=r["door_reply_s_max"], gw=r["gateway_tx_pct_of_hour"], s3=f["after 3 missed"], s4=f["after 4 missed"])), flush=True)

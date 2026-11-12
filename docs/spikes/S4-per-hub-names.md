# S4. Per-hub HTTPS names (`<hub-id>.hubs.example.com`)

Desk research, 12 November 2026. No code was written. `hubs.example.com` is a placeholder.

## Summary

1. Let's Encrypt allows 50 new certificates per registered domain per week by default. That is the only limit that hurts us early. Renewals made through ARI are exempt from every limit.
2. Every comparable project (Tailscale, Nabu Casa, libp2p, Synology) ended up on the Public Suffix List, which makes each hub name its own "registered domain". The list will not accept us until we serve thousands of users, and not for rate-limit reasons alone.
3. Many home routers drop DNS answers that point a public name at a private address. OpenWrt, pfSense, FRITZ!Box and Google Wifi do this by default. The router on the machine used for this research does it too.
4. The blocked answer is usually "no error, zero answers", not NXDOMAIN. Public resolvers (1.1.1.1, 8.8.8.8, 9.9.9.9, OpenDNS) do not block. So a hub and a phone on the same network can see different results.
5. Chrome's Local Network Access prompt applies to public pages calling local addresses. A page loaded from the hub's own name (which resolves to a private address) calling its own origin is not gated today. A cloud-hosted page calling the hub is.
6. Recommended: the hub runs its own ACME client, we only publish the DNS-01 record, each hub has a stable name, the hub tests the router's resolver directly, and when the name is blocked we point that hub's name at our relay with TLS still ending on the hub.

## How to read the source labels

Each claim is followed by its source and one of these labels.

| Label | Meaning |
|---|---|
| **P** | Read in the primary source. I opened the vendor's or project's own page, source file or specification. |
| **P-measured** | A primary observation: I ran the DNS query myself on 12 November 2026 and report the answer. |
| **S** | From a secondary source: a forum post, a third-party article, or a search-engine summary of a page I could not open. |
| **U** | Could not verify. The page refused my fetch, was missing, or I found nothing. |

Two caveats. Most pages were read through a fetch tool that extracts text and summarises it, so short quotes are reliable but long passages are paraphrased. The Let's Encrypt rate-limit page, the Public Suffix List file, the OpenWrt files and the dnsmasq source were read as raw text.

---

## Part 1. Certificate issuance at scale

### 1.1 Let's Encrypt rate limits (page last updated 5 August 2026)

All rows: https://letsencrypt.org/docs/rate-limits/ (P, raw text).

| Limit | Number | Refill | Override possible? |
|---|---|---|---|
| New certificates per registered domain | 50 every 7 days | 1 every 202 minutes | Yes, for the domain or for an account |
| New certificates per exact set of identifiers | 5 every 7 days | 1 every 34 hours | No |
| New orders per account | 300 every 3 hours | 1 every 36 seconds | Yes, for a specific account |
| New account registrations per IPv4 address | 10 every 3 hours | 1 every 18 minutes | No |
| New account registrations per IPv6 /48 | 500 every 3 hours | 1 every 22 seconds | No |
| Authorization failures per identifier per account | 5 per hour | 1 every 12 minutes | No |
| Consecutive authorization failures per identifier per account | 1,152 | 1 per day, reset on success | No |

Points that matter for us:

- The per-domain limit is global. The page says "all new order requests, regardless of which account submits them, count towards this limit". (P)
- The registered domain is found with the Public Suffix List. "We use the Public Suffix List to identify registered domains." (P)
- Limits use a token bucket. A burst up to the full limit is allowed, then it refills slowly. Revoking a certificate does not give capacity back. (P)
- Up to 100 identifiers per certificate, depending on the profile. (P)

**Renewals.**

- ARI renewals are "exempt from all rate limits". The condition: the new order names the certificate it replaces, shares at least one identifier with it, and that certificate "has not been previously replaced using ARI". (P)
- Without ARI, an order with the exact same set of names counts as a renewal. It is exempt from "New Orders per Account" and "New Certificates per Registered Domain". It is still subject to the 5-per-week exact-set limit and to authorization-failure limits. (P)
- Let's Encrypt recommends checking ARI "at least twice a day" per certificate, with renewal at one third of lifetime remaining as a backstop. https://letsencrypt.org/docs/integration-guide/ (P)

**Requesting an increase.**

- There is a form for "a large hosting provider or organization working on a Let's Encrypt integration". "It takes a few weeks to process requests." Only two limits can be raised: new orders per account, and new certificates per registered domain. https://letsencrypt.org/docs/rate-limits/ (P)
- Let's Encrypt recommends one ACME account for large integrators. It "will be unable to effectively adjust rate limits if many different accounts are used". https://letsencrypt.org/docs/integration-guide/ (P)
- The form's exact questions and approval criteria: U. Forum posts say a request can name at most three domains and that requests are processed in batches every few weeks. https://community.letsencrypt.org/t/rate-limit-adjustment-request-form-clarifications-questions/103762 (S)
- A Let's Encrypt engineer (aarongable, August 2024) told the libp2p team that an override on a domain stops mattering once that domain is on the Public Suffix List, "so getting the override will have largely been a waste of your time and ours". He told them to do the list first. https://community.letsencrypt.org/t/feedback-on-raising-certificates-per-registered-domain-to-enable-peer-to-peer-networking/223003 (P)
- The same engineer asked integrators for three things: jittered renewal times, ARI support, and clients that update themselves. Same thread. (P)

**Certificate lifetimes are shrinking.** This sets our renewal load.

| Date | Change | Source |
|---|---|---|
| Now | `classic` profile: 90 days, authorization reuse 30 days | https://letsencrypt.org/docs/profiles/ (P) |
| 13 May 2026 | `tlsserver` profile (opt-in): 45 days, authorization reuse 7 hours | https://letsencrypt.org/2025/12/02/from-90-to-45 (P) |
| 10 February 2027 | `classic`: 64 days, authorization reuse 10 days | same (P) |
| 16 February 2028 | `classic`: 45 days, authorization reuse 7 hours | same (P) |

- A `shortlived` profile (160 hours) also exists. https://letsencrypt.org/docs/profiles/ (P)
- A new challenge, DNS-PERSIST-01, would let us publish one TXT record per hub once instead of at every renewal. Let's Encrypt said in December 2025 it expected it "in 2026". https://letsencrypt.org/2025/12/02/from-90-to-45 (P). A September 2026 article says the rollout is on hold. https://www.captaindns.com/en/blog/dns-persist-01-tls-certificate-domain-validation (S). The challenge-types page (updated 12 February 2026) does not list it. https://letsencrypt.org/docs/challenge-types/ (P). Current status: U.
- Wildcards need DNS-01. `_acme-challenge` can be delegated by CNAME or NS to a validation-only zone. https://letsencrypt.org/docs/challenge-types/ (P)
- Plex forum users reported in September 2026 that renewals came from a new Let's Encrypt root hierarchy that some clients did not yet trust. https://forums.plex.tv/t/https-certs-are-missing-trust-roots/943238 (S). Not checked against Let's Encrypt's own pages: U.

### 1.2 How comparable projects solved it

| Project | Name shape | Who holds the key | Issuer and method | On the Public Suffix List? | Sources |
|---|---|---|---|---|---|
| Plex `plex.direct` | `<ip-with-dashes>.<hash>.plex.direct`, wildcard `*.<hash>.plex.direct` per server | The server | DigiCert partnership from 2015, with a dedicated intermediate. Moved to Let's Encrypt in February 2021. | No (checked the list file of 11 Nov 2026) | https://words.filippo.io/how-plex-is-doing-https-for-all-its-users/ (S, 2015 analysis), https://forums.plex.tv/t/tls-certificate-transition/689056 (P, Plex forum announcement), https://publicsuffix.org/list/public_suffix_list.dat (P) |
| Tailscale `ts.net` | `<machine>.<tailnet>.ts.net`, single name | The node. "Tailscale never sees them." The node also holds its own ACME account key. | Let's Encrypt, DNS-01. The control plane sets the TXT record. | Yes: `ts.net`. Added October 2021. | https://tailscale.com/kb/1153/enabling-https (P), https://tailscale.com/blog/tls-certs (P), https://github.com/publicsuffix/list/pull/1453 (P) |
| Nabu Casa (Home Assistant Cloud) | `<id>.ui.nabu.casa`, single name plus optional aliases | The Home Assistant instance. Account key and certificate key are created and stored locally. | ACME DNS-01. The instance asks the cloud API to create the challenge record. Let's Encrypt per Nabu Casa's own docs. | Yes: `ui.nabu.casa` | https://github.com/NabuCasa/hass-nabucasa/blob/main/hass_nabucasa/acme.py (P), https://publicsuffix.org/list/public_suffix_list.dat (P), Nabu Casa support pages (S, returned HTTP 403 to me) |
| libp2p `libp2p.direct` (AutoTLS) | `<ip>.<peer-id>.libp2p.direct`, wildcard per peer | The peer (the readme does not say so in words) | Let's Encrypt, DNS-01. A broker checks the peer and writes the TXT record. | Yes: `libp2p.direct`. Added August 2024. | https://github.com/ipshipyard/p2p-forge (P), https://github.com/publicsuffix/list/pull/2084 (P) |
| Synology | `<name>.synology.me`, wildcard supported for Synology DDNS names only | The NAS | Let's Encrypt. Synology says its DDNS supports DNS-01. | Yes: `synology.me`, `direct.quickconnect.to` | https://synology.com/en-us/knowledgebase/tutorials/611 (S, page body did not render for me), https://publicsuffix.org/list/public_suffix_list.dat (P) |
| Unraid `myunraid.net` | `<lan-ip-with-dashes>.<40-char-hash>.myunraid.net` | The server | Wildcard Let's Encrypt certificate, provisioned from the server UI | No | https://docs.unraid.net/unraid-os/system-administration/secure-your-server/securing-your-connection (P), list file (P) |
| `sslip.io` / `nip.io` | `<ip>.nip.io` | Each user, per hostname | No shared wildcard. Users get their own certificate by HTTP-01, so it only works for public addresses. | No | https://nip.io/ (P), list file (P) |
| `local-ip.co` | `<ip-with-dashes>.my.local-ip.co` | Everyone. The private key is a public download. | One shared wildcard | No | https://local-ip.co/ (P) |
| `localtls` | `<ip-with-dashes>.yourdomain.net` | Everyone by default. Keys served over HTTP. | One shared wildcard from Let's Encrypt | n/a | https://github.com/Corollarium/localtls (P) |

Notes on the table:

- Tailscale already had a raised Let's Encrypt limit before it asked for the list entry. Its engineer wrote "we've already been granted an increased issuance rate limit with Let's Encrypt directly" and "We have no purpose for PSL inclusion other than cookie security." https://github.com/publicsuffix/list/pull/1453 (P)
- Tailscale documents the default limit as it applies to one customer: 50 certificates per week per tailnet, 5 duplicates per week. That is the per-registered-domain limit applied to each tailnet name, which is what the list entry gives. https://tailscale.com/docs/kubernetes-operator/manage-and-configure/lets-encrypt-rate-limits (P)
- libp2p planned for 5,000 to 10,000 certificates a week. Let's Encrypt staff steered them to the list, not to an override. https://community.letsencrypt.org/t/feedback-on-raising-certificates-per-registered-domain-to-enable-peer-to-peer-networking/223003 (P)
- Let's Encrypt has raised the nip.io / sslip.io limit over the years but "turned down our request for 500,000". https://nip.io/ (P)
- Nabu Casa says openly that because it owns the domain it could issue its own certificate and intercept connections. It points to open-source request code and Certificate Transparency as the check on that. https://support.nabucasa.com/hc/en-us/articles/25619268678557-Remote-UI-Deep-dive (S, via search summary). The same is true of our design.
- How Plex handles Let's Encrypt limits today (override, or other): U. `plex.direct` is not on the list, so it must hold an override or an arrangement.

**Why a shared wildcard key is unsafe.**

- Every installed copy holds the same private key. Anyone who extracts it can impersonate every name under the wildcard. The `localtls` readme agrees that a man-in-the-middle attack is possible and calls the result "as safe as a plain HTTP website if you release the private key". https://github.com/Corollarium/localtls (P)
- Anyone who holds a certificate's private key can ask Let's Encrypt to revoke it. https://letsencrypt.org/docs/revoking/ (P). So one hostile user can take every hub offline.
- It has happened. sslip.io "no longer maintains a wildcard certificate" after its key was exposed in 2015 and the certificate was revoked. https://nip.io/ (P)
- Certificate authorities must revoke a certificate within 24 hours of learning its key is compromised (CA/Browser Forum Baseline Requirements, section 4.9.1.1). I did not open that document: U.

### 1.3 Public Suffix List

What inclusion gives us:

- Each `<hub-id>.hubs.example.com` becomes its own registered domain for Let's Encrypt. The 50-per-week limit then applies per hub, not across all hubs. https://letsencrypt.org/docs/rate-limits/ (P)
- Browsers stop one hub from setting cookies for another hub's name. Let's Encrypt staff said a service like this needs "cookie and cross-origin domain separation" between subdomain owners anyway. https://community.letsencrypt.org/t/feedback-on-raising-certificates-per-registered-domain-to-enable-peer-to-peer-networking/223003 (P)

Requirements, all from https://github.com/publicsuffix/list/wiki/Guidelines (P):

- A `_psl` TXT record on each submitted suffix, pointing at the pull request. It should stay in place.
- The domain's registration must expire "more than 2 years beyond the submitting date".
- "projects not serving more then thousands of users are quite likely to be declined". Small, test or beta projects are likely to be rejected.
- "We do not accept entries whose sole purpose is to circumvent rate limits of third parties". The guidelines send such requests to Let's Encrypt's own form.

Time:

- "There are NO SERVICE LEVEL AGREEMENTS ON TIME". Same page. (P)
- Tailscale: opened 8 October 2021, merged 16 October 2021. https://github.com/publicsuffix/list/pull/1453 (P)
- libp2p: opened 6 August 2024, merged 9 August 2024. It reached Let's Encrypt's software on 19 August and was deployed that week. So about two to three weeks from request to effect at Let's Encrypt. https://community.letsencrypt.org/t/feedback-on-raising-certificates-per-registered-domain-to-enable-peer-to-peer-networking/223003 (P)
- Browsers pick the list up on their own release schedule. "Changes to the PSL may take time to percolate to clients". https://github.com/publicsuffix/list/wiki/Guidelines (P). So the cookie protection arrives weeks to months after the rate-limit effect.

### 1.4 Other free ACME issuers

| Issuer | Status | Limits | Source |
|---|---|---|---|
| ZeroSSL | Operating. Free 90-day certificates by ACME, including wildcards. Needs External Account Binding credentials from a ZeroSSL account. | No numbers published. Abusive clients may be restricted. Credential creation is capped per user per day. | https://zerossl.com/documentation/acme/ (P) |
| Google Trust Services (Public CA) | Operating. Needs a Google Cloud project and External Account Binding. | 100 new orders per hour per Google Cloud project by default. All ACME accounts in a project share it. Per-domain limits: not stated. | https://docs.cloud.google.com/certificate-manager/docs/quotas (P) |
| Buypass Go SSL | Ended. Announced 18 August 2025. No new orders or renewals after 15 October 2025. | n/a | https://buypass.com/products/tls-ssl-certificates/discontinues-issuance-of-tls-ssl-certificates (S, via search summary) |

Others exist (SSL.com, Actalis). I did not check them: U.

### 1.5 One name per hub, or a wildcard per hub

| | Single name `<hub-id>.hubs.example.com` | Wildcard `*.<hub-id>.hubs.example.com` with the address in the name |
|---|---|---|
| Used by | Tailscale, Nabu Casa | Plex, libp2p, Unraid |
| DNS | Stateful. The hub must tell us its current home-network address. We answer with it. | Stateless. The answer is computed from the name. |
| Home-network address changes | We update the record. Old answers linger for the record's lifetime. | Works at once. The app just builds a new name. |
| Browser origin | Stable. Logins, saved passwords, installed web app, service worker and local storage survive an address change. | Changes when the address changes. All per-origin browser state is lost. |
| What the public log shows | The hub name. Anyone can then look up the name and read the hub's private address. | Only `*.<hub-id>…`. No address. |
| Abuse surface | Small. A name only ever points where the hub said. | Larger. Anyone can make a name under our domain point at any address unless the DNS server restricts answers to private ranges and known hub ids. |
| Rate-limit cost | One order, one certificate | Same |

The origin row and the abuse row are my reasoning, not sourced claims. For a security product with logins, the stable origin matters most. A single certificate can carry both the plain name and the wildcard (two identifiers, one order). That keeps the option open at no rate-limit cost.

### 1.6 Certificate Transparency

- "Let's Encrypt submits all certificates we issue to CT logs." https://letsencrypt.org/docs/ct-logs/ (P)
- Tailscale warns customers that the public ledger "includes the fully qualified domain name of your devices" and says not to enable HTTPS "if any of your machine names contain sensitive information". https://tailscale.com/kb/1153/enabling-https (P)
- Anyone can list certificates for a domain through crt.sh or Censys. https://letsencrypt.org/docs/rate-limits/ (P)

What this exposes for us (my analysis):

- The full list of hub ids, so the number of hubs and our growth rate.
- When each hub was first set up, and its renewal rhythm. A hub that stops renewing is visibly gone.
- With single names, the private address of each hub, by resolving each logged name. This is low value to an attacker who is not on that network, but it is public.

Consequences:

- Hub ids must be random. They must not contain a customer name, email, serial number or postcode.
- A hub id must never work as a password or capability. It is public from the first certificate.
- Never publish a hub's public address under these names.

---

## Part 2. Routers and resolvers that block the name

### 2.1 What I measured

I queried names that are public and resolve to private addresses: `192-168-1-10.nip.io`, `10.0.0.5.sslip.io` and Unraid's test name `rebindtest.myunraid.net` (which returns 192.168.42.42). All results are P-measured, 12 November 2026, from one home connection (the development machine's own network).

| Resolver | Answer |
|---|---|
| Cloudflare 1.1.1.1 | Private address returned |
| Cloudflare 1.1.1.2 (malware) and 1.1.1.3 (family) | Private address returned |
| Google 8.8.8.8 | Private address returned |
| Quad9 9.9.9.9, 9.9.9.10, 149.112.112.11 | Private address returned |
| OpenDNS 208.67.222.222 and FamilyShield 208.67.222.123 | Private address returned (no account settings applied) |
| AdGuard DNS 94.140.14.14 and .15 | Private address returned |
| Control D 76.76.2.0 and 76.76.2.2 | Private address returned |
| CleanBrowsing 185.228.168.9 | Private address returned |
| NextDNS 45.90.28.0 (no profile) | Private address returned |
| Cloudflare DNS over HTTPS (`cloudflare-dns.com`) | Private address returned |
| The local router's resolver (reports itself as `dnsmasq-2.83`) | **Blocked.** Status NOERROR, zero answers. Same for a name pointing at 127.0.0.1. A control name with a public address resolved normally. |
| The same router, AAAA record pointing at a private IPv6 address (`fd00::1`) | **Not blocked.** The address was returned. |
| The operating system resolver (`getaddrinfo`) on that machine | Failed: "nodename nor servname provided, or not known" |

So this one network shows the whole problem. The router blocks. Public resolvers and DNS over HTTPS do not. IPv6 is treated differently from IPv4.

### 2.2 Routers and local resolvers

| Product | Blocks by default? | What the blocked answer looks like | Fix (exact setting where documented) | Sources |
|---|---|---|---|---|
| dnsmasq (the engine in many routers) | No. Only with `--stop-dns-rebind`. | NOERROR with all answers removed, plus an extended error code "Blocked". Logs "possible DNS-rebind attack detected". | `rebind-domain-ok=/hubs.example.com/` | https://thekelleys.org.uk/dnsmasq/docs/dnsmasq-man.html (P), source `src/forward.c` at https://github.com/imp/dnsmasq (P, a mirror; the official repository asked for a login), measurement above |
| OpenWrt | **Yes.** The shipped config has `option rebind_protection 1`. | As dnsmasq | Add `list rebind_domain 'hubs.example.com'` to the `dnsmasq` section of `/etc/config/dhcp`. Or set `option rebind_protection 0`. | https://github.com/openwrt/openwrt/blob/main/package/network/services/dnsmasq/files/dhcp.conf (P), https://github.com/openwrt/openwrt/blob/main/package/network/services/dnsmasq/files/dnsmasq.init (P). The web-interface labels: U (the OpenWrt wiki refused my fetch). |
| pfSense | **Yes.** "DNS rebinding attack protection is active by default." | Private addresses are stripped from the answer | DNS Resolver, Custom Options: `server:` then `private-domain: "hubs.example.com"`. DNS Forwarder, Advanced Settings: `rebind-domain-ok=/hubs.example.com/`. Global switch: System > Advanced > Admin Access > DNS Rebind Check. | https://docs.netgate.com/pfsense/en/latest/services/dns/rebinding.html (P) |
| OPNsense (Unbound) | The docs do not state the default. It applies when the DNS rebind check is enabled under Administration. | Matching addresses "removed from DNS answers". May also be marked bogus by DNSSEC validation. | Services > Unbound DNS > Advanced > "Private Domains": add `hubs.example.com` | https://docs.opnsense.org/manual/unbound.html (P). Default on: U. |
| Unbound (plain) | No. "No private addresses are enabled by default." | Addresses removed. "the DNSSEC validator may mark the answers bogus", which would give SERVFAIL (my inference). | `private-domain: "hubs.example.com"` | https://unbound.docs.nlnetlabs.nl/en/latest/manpages/unbound.conf.html (P) |
| AVM FRITZ!Box | **Yes**, with a list of exceptions | AVM describes "DNS timed out" or "DNS request timed out" on the client | Home Network > Network > Network Settings > advanced settings > DNS Rebind Protection > "Host name exceptions". Enter the full host name. Separate several entries with spaces. Save and restart. | AVM knowledge base articles 663 and 3565, e.g. https://en.avm.de/service/knowledge-base/dok/FRITZ-Box-4020/663_No-DNS-resolution-of-private-IP-addresses (S: read only as a search summary; the page redirected to a missing page for me) |
| Google Wifi / Nest Wifi | **Yes.** "This feature is enabled by default on Google Wifi." | U | No per-domain exception. Set a custom DNS server in the Google Home app. Google suggests 8.8.8.8. | https://support.google.com/googlenest/answer/9144137 (P) |
| ASUS (stock firmware) | Default not stated by ASUS. A forum settings list shows "No" as default. | U | WAN > Internet Connection > WAN DNS Setting > "Enable DNS Rebind protection": set to No | https://www.asus.com/support/FAQ/1011715 (P for the setting), https://www.snbforums.com/threads/would-any-of-this-make-my-browsing-more-secure-wan-dns-settings.89265 (S for the default) |
| Netgear | A "DNS Rebind Protection" feature exists on Nighthawk M7 mobile routers. Default not stated. An Orbi user reports the feature exists with no user setting. | U | M7 Pro only: SETTINGS > Advanced > Mobile Router Setup > clear "DNS Rebind Protection" | https://kb.netgear.com/000066611/How-to-disable-DNS-Rebind-Protection-on-the-Nighthawk-M7 (P), https://community.netgear.com/t5/Orbi-WIFI-6-AX-AND-Wi-Fi-6E-AXE/DNS-Rebinding-amp-Permitting-a-private-domain/m-p/2216764 (S) |
| TP-Link | U. I found no documentation of such a feature. | U | U | none |
| Ubiquiti UniFi | Mixed reports. Older posts say not on by default on the USG. A February 2026 post reports a new gateway on UniFi Network 10 blocking Plex, with no named setting. | U | No confirmed fix. Old gateways accepted `rebind-domain-ok` through `config.gateway.json`. | https://forums.plex.tv/t/unifi-gateway-plex-remote-access-dns-rebinding-protection-whitelist/936735 (S), https://forums.unraid.net/topic/65785-640-error-trying-to-provision-certificate-your-router-or-dns-provider-has-dns-rebinding-protection-enabled/ (S) |
| BT Smart Hub / Home Hub | Forum users report the hub's own DNS drops such answers and offers no exception list | U | Set a public DNS server on each device. The hub's DNS cannot be changed, per those users. | https://forums.plex.tv/t/no-direct-local-access-connecting-with-relay-only-but-i-do-have-remote-access/319952 (S). BT's own forum returned HTTP 403: U. |
| Virgin Media Hub 3 / Hub 5 | Forum users report private addresses often do not resolve through the Hub 5 in router mode | "sometimes it resolves, other times I get no response" | Suggested by users: modem mode with a separate router | Virgin Media community threads (S, via search summary; the site did not resolve for me) |
| Sky routers | U. Nothing found. | U | U | none |
| Vodafone UK, Plusnet (BT hardware) | Thread titles show users asking to disable rebind protection | U | U | https://community.plus.net/t5/My-Router/How-to-disable-DNS-Rebinding-Protection/m-p/1805830 (U: HTTP 403) |
| German ISP routers (Speedport, Vodafone Station) | U. Nothing found. Many German homes use a FRITZ!Box. | U | U | none |
| Dutch ISP routers (KPN, Ziggo) | U. Nothing found. | U | U | none |
| Pi-hole | No. "Rebind protection isn't enabled by default with Pi-hole." But Pi-hole often forwards to the router, which may block. | As dnsmasq when enabled | Add `rebind-domain-ok=/hubs.example.com/` through `misc.dnsmasq_lines`, or in `/etc/dnsmasq.d/` with `misc.etc_dnsmasq_d` on | https://discourse.pi-hole.net/t/add-plex-direct-to-dns-rebinding/74780 (P, Pi-hole forum), https://docs.pi-hole.net/ftldns/configfile/ (P) |
| AdGuard Home | No built-in switch. Since v0.107.67 (September 2025) it offers an optional filter list, "HaGeZi's DNS Rebind Protection". | Follows AdGuard Home's blocking mode: U | Add an allow rule for the domain in custom filtering rules. A user confirmed an allow-list entry works. | https://github.com/AdguardTeam/AdGuardHome/issues/102 (P) |

Plex's own support article on this (https://support.plex.tv/articles/206225077-how-to-use-secure-server-connections/) returned HTTP 403 to my fetch. Everything about Plex's advice here comes from forum posts that refer to it: U for the article itself.

### 2.3 Public resolvers

| Resolver | Blocks private answers? | Source |
|---|---|---|
| Cloudflare 1.1.1.1, 1.1.1.2, 1.1.1.3 | No (measured). For domains it does block as malicious, it returns `0.0.0.0`. | Measurement, https://developers.cloudflare.com/1.1.1.1/setup/ (P) |
| Google 8.8.8.8 | No (measured). Google's security page does not mention rebinding. | Measurement, https://developers.google.com/speed/public-dns/docs/security (P) |
| Quad9 | No (measured) | Measurement |
| OpenDNS | Not by default (measured without an account). An account option "Block internal IP addresses" exists and is reported off by default. | Measurement, https://www.eweek.com/blogs/security-watch/opendns-takes-aim-at-dns-rebinding-attacks/ (S, 2008). Cisco's forum returned HTTP 403: U. |
| NextDNS | Per-profile option "DNS Rebinding Protection". A NextDNS help article says "This protection is not turned on by default." Staff advice is to add the domain to the allow list. One user said that did not work. | https://help.nextdns.io/t/35hmval/what-is-dns-rebinding-protection (P, help forum), https://help.nextdns.io/t/83hbdyz/dns-rebinding-protection-and-private-ips (P). Current default and blocked answer format: U. |

Tailscale's own help page gives the same picture: it names Google Wifi and unnamed ISP and corporate resolvers as blockers, and Google Public DNS, Cloudflare and Quad9 as resolvers that do not block. https://tailscale.com/docs/reference/faq/dns-rebinding (P)

### 2.4 How the hub can detect it by itself

Unraid already does this. It publishes `rebindtest.myunraid.net`, which resolves to 192.168.42.42 (P-measured), and refuses to provision with a message about DNS rebinding protection when the test fails. https://forums.unraid.net/topic/65785-640-error-trying-to-provision-certificate-your-router-or-dns-provider-has-dns-rebinding-protection-enabled/ (S). Unraid's docs describe the user-facing side only. https://docs.unraid.net/unraid-os/system-administration/secure-your-server/securing-your-connection (P)

A workable test:

1. Resolve the hub's own name and a fixed canary name (for example `rebindtest.hubs.example.com`, always a private address).
2. Resolve a control name under the same domain that has a public address. This separates "DNS is down" from "private answers are filtered".
3. Compare with the address the hub knows it has.

Result table (the first three rows match what was measured or read above; the rest are expected, not observed):

| Observation | Meaning |
|---|---|
| Canary returns the expected private address | Not blocked on this resolver |
| NOERROR with zero answers, control fine | Blocked (dnsmasq, pfSense, Unbound style) |
| Timeout, control fine | Blocked (FRITZ!Box style, per AVM's description) |
| NXDOMAIN, `0.0.0.0`, REFUSED or SERVFAIL, control fine | Treat as blocked |
| Control also fails | DNS problem. Say nothing about rebinding. |

Ways this gives a wrong result:

| Cause | Wrong result | Mitigation |
|---|---|---|
| The hub uses a different resolver from other devices (static DNS, a container's built-in resolver, a VPN) | Hub says "fine" while phones are blocked | Also query the router directly: send the test to the default gateway and to the DNS servers from the DHCP lease, on port 53. Do not rely on the operating system resolver alone. |
| A browser or phone uses DNS over HTTPS or Android Private DNS | Hub says "blocked" while that device works. Measured here: the router blocked while Cloudflare DNS over HTTPS answered. | Report "may be blocked for some devices". Confirm from the client side before showing instructions. |
| IPv6 | dnsmasq's manual says its filter covers private IPv6 ranges, but the router measured here let a private IPv6 answer through. A global IPv6 address is not private, so no filter touches it. | Test A and AAAA separately. Do not assume they behave alike. |
| Several resolvers on the network (router plus Pi-hole) | Different answers per device | Test each resolver the lease lists |
| Cached negative answers | The fix seems not to work for a while | Keep the zone's negative-caching time short. Re-test after a delay. |

### 2.5 How a web page or phone app can detect it

Web page:

- A page cannot make DNS queries. It can only try to load something from the hub name and see a generic failure.
- A page on our cloud site that calls the hub name is a public-to-local request. Chrome will show its Local Network Access prompt (see Part 3). So this test itself can trigger a prompt.
- A page can ask a public DNS-over-HTTPS service, but that shows the public answer, not what the home router says.
- Practical approach: the cloud page asks the hub through the relay whether it is online and what its self-test found. Then it navigates the browser to the hub name. If the hub is online by relay but the name does not load, show the router help. This is my design suggestion, not a sourced method.

Phone app:

- A native app can resolve the name itself and compare it with the address the hub reported through the relay. That gives a clear answer per device.
- A native app can also skip DNS: connect to the hub's address directly and check the certificate against the hub name. Then the router's filter does not matter for the app. This is my suggestion, not sourced.

---

## Part 3. Browser and phone restrictions

### 3.1 Chrome: Local Network Access

- It "restricts the ability of websites to send requests to servers on a user's local network", behind a permission prompt. It replaces Private Network Access, which was put on hold. The prompt launched in Chrome 142. https://developer.chrome.com/blog/local-network-access (P)
- A local network request is one "from the public network to a local network or loopback destination". Local means ranges such as 192.168.0.0/16, 169.254.0.0/16, fc00::/7, fe80::/10. Same page. (P)
- A document's address space comes from the address it was loaded from, not from its host name. https://wicg.github.io/local-network-access/ section 3.5 (P)
- A request needs permission only when the target is "less public than" the page. Local to local does not qualify. The specification notes "Chromium only implements Local Network Access restrictions for public to local or loopback requests" and that it "does not enforce the permission for cross-origin local requests". Same specification, section 2.2. (P)
- Top-level navigations are in the specification in principle, but "Chromium only applies LNA restrictions to iframe navigations currently". Same specification. (P)
- WebSockets were added later. The intent to ship is dated 19 February 2026 and targets Chrome 147 on desktop and Android, not Android WebView. https://groups.google.com/a/chromium.org/g/Blink-dev/c/O6GMKt44Ups (P). Whether it reached stable in 147: S (third-party guides say April 2026).
- The permission can only be requested from a secure context. Permissions "are denied automatically in insecure (`http://`) top-level contexts". https://developer.chrome.com/docs/modern-web-guidance/guides/security/local-network-access (P)
- Cross-origin iframes need the permission delegated to them. Service workers fail unless the permission was already granted. Same page. (P)
- Chrome plans to extend protection later to "all cross-origin requests going to destinations on the local network", including from a local page. https://developer.chrome.com/blog/local-network-access (P)

Answers to the two questions:

| Case | Chrome today |
|---|---|
| User opens `https://<hub-id>.hubs.example.com` (resolves to a private address) as a top-level page | No prompt and no block. Top-level navigation is not gated. (P, specification note) |
| That page opens a WebSocket or makes fetches to its own origin | No prompt. The page is in the local address space and the target is equally local. (P, specification section 2.2; this exact case is my reading, not a quoted statement) |
| Our cloud page (`app.example.com`) fetches from, frames, or opens a WebSocket to the hub name | Prompt. Public to local. (P) |
| Our cloud page links or redirects the whole tab to the hub name | No prompt today. May change, especially for pop-ups. (P, specification open issue) |
| The hub name sometimes resolves to our relay (public) and sometimes to the hub (private) during one session | A page loaded through the relay is public. A later request that lands on the private address is then public to local, and prompts. (My inference from the rules above.) |

### 3.2 Firefox and Safari

- Firefox has the same kind of prompt. Mozilla's support article says restrictions will be on by default and lists the preferences `network.lna.enabled`, `network.lna.blocking` and `network.lna.skip-domains`. One language version says rollout begins with Firefox 151. https://support.mozilla.org/en-US/kb/control-personal-device-local-network-permissions-firefox (S: the page did not load for me; this is the search summary). A third-party article says it was first rolled out to users with strict tracking protection. https://help.twingate.com/articles/4097879304-browser-local-network-access-lna-blocking-twingate-resources (S)
- Safari has not shipped it. WebKit bug reports from July to September 2026 show enforcement being built, with no prompt yet. https://bugs.webkit.org/show_bug.cgi?id=323474 (S, via search summary). Release timing: U.
- Whether Firefox and Safari treat a local page calling its own origin the same way as Chrome: U. The shared specification says they should.

### 3.3 Operating-system permissions

**iOS and iPadOS** (all from Apple technical note TN3179, https://developer.apple.com/documentation/technotes/tn3179-understanding-local-network-privacy, P):

- An outgoing TCP connection to a local network address needs local network access. So do UDP sends and all Bonjour operations.
- Resolving a normal (non-`.local`) DNS name does not need it. The connection that follows does.
- Add `NSLocalNetworkUsageDescription` to the app's Info.plist. Add `NSBonjourServices` if the app browses for services.
- "There's no general API that returns whether the current process has local network access" and no API to show the alert. A denied connection sits in a waiting state with reason `localNetworkDenied`.
- The alert is shown once. The choice is remembered.
- "Traffic originating from WKWebView, SFSafariViewController, and Safari doesn't require local network access."
- That last line conflicts with an Apple engineer's forum reply in January 2026: "a web view running in your app is considered to be your app from the perspective of local network privacy". https://developer.apple.com/forums/thread/811690 (P). Which one holds for an in-app web view: U. Test on a device.

**macOS:**

- Local network privacy applies from macOS 15. Safari is exempt (line quoted above). Other browsers are ordinary apps, so Chrome and Firefox need the user to allow them under System Settings > Privacy & Security > Local Network. The first part is P (TN3179). That Chrome shows this prompt is S (the forum thread above).

**Android** (all from https://developer.android.com/privacy-and-security/local-network-permission, P):

- "Starting in Android 17 (API level 37), local network protections are enforced for apps targeting Android 17 or higher."
- The app must declare and request `ACCESS_LOCAL_NETWORK` at run time. It sits in the Nearby devices permission group.
- Apps that target a lower level keep access for now through the normal internet permission.
- Outgoing TCP connections to local addresses need it. Without it, "TCP Connections will typically result in a timeout error".
- Web views inherit the host app's permission state. Browsers are affected like any app.
- Traffic to a DNS server on the local network (port 53) is exempt.
- A system picker for mDNS discovery lets an app reach one chosen device without the broad permission.

### 3.4 Secure contexts

- `crypto.getRandomValues()` works on plain HTTP pages. MDN: "`getRandomValues()` is the only member of the `Crypto` interface which can be used from an insecure context." https://developer.mozilla.org/en-US/docs/Web/API/Crypto/getRandomValues (P)
- `crypto.subtle` needs a secure context. MDN: "This feature is available only in secure contexts (HTTPS)". https://developer.mozilla.org/en-US/docs/Web/API/Crypto/subtle (P). By the first quote, `crypto.randomUUID()` needs one too.
- A plain-HTTP page on a home-network address is not a secure context. Only `https`, `wss`, `file`, loopback addresses and `localhost` names count as potentially trustworthy. https://developer.mozilla.org/en-US/docs/Web/Security/Secure_Contexts (P; the page does not name 192.168 addresses, this follows from its list)
- MDN's example gates service worker registration on `window.isSecureContext`. Same page. (P)

After a certificate warning is clicked through:

| Question | Finding | Source |
|---|---|---|
| Does the specification treat such a page as secure? | The test is by scheme: "If origin's scheme is either "https" or "wss", return "Potentially Trustworthy"." It says nothing about certificate errors. So by the specification, yes. | https://w3c.github.io/webappsec-secure-contexts/ (P) |
| Firefox | Mozilla engineers stated: "If a resource has loaded over HTTPS, it is trusted, either through our built in trust settings or the user's." The same report says a self-signed site's service worker registered in Firefox. That discussion is from 2015. | https://bugzilla.mozilla.org/show_bug.cgi?id=1162772 (P, old) |
| Chrome: service workers | The same report says Chrome refused the service worker with "An SSL certificate error occurred when fetching the script." Chromium's own FAQ offers `--ignore-certificate-errors` for testing, which implies the default is refusal. | same bug (P), https://new.chromium.org/blink/serviceworker/service-worker-faq/ (P) |
| Chrome: passkeys (WebAuthn) | Disabled on such pages since Chrome 110, to "prevent bad actors from generating valid assertions by mitm'ing users who may skip the interstitial". | https://lists.w3.org/Archives/Public/public-webauthn/2022Nov/0135.html (P) |
| Firefox: passkeys | Firefox blocks WebAuthn when an untrusted-issuer or wrong-domain override is in use (CVE-2025-6433). | https://bugzilla.mozilla.org/show_bug.cgi?id=1954033 (S, via search summary) |
| Chrome: value of `isSecureContext` and availability of `crypto.subtle` after click-through | U. Expected to be true by the specification. Not confirmed from a primary source. | none |
| Safari: all of the above | U | none |

Do not design around click-through certificates. Even where the page counts as secure, service workers (Chrome) and passkeys (Chrome, Firefox) are switched off, and the behaviour is not documented well enough to rely on.

---

## Recommendation for our design

### How to issue certificates

1. **Use a separate registrable domain for hub names**, not our main domain. Rate limits, the public log, the Public Suffix List entry and any abuse reports then stay away from the product domain. (My recommendation.)
2. **The hub runs the ACME client and holds both keys** (certificate key and ACME account key). Our service only writes and removes the `_acme-challenge` TXT record for that hub's own name, after authenticating the hub. This is what Tailscale and Nabu Casa do. It keeps private keys off our servers and means account-level limits apply per hub.
3. **Let the service tell the hub which ACME directory to use**, as Nabu Casa does. Then we can move hubs to Google Trust Services or ZeroSSL without a software update if Let's Encrypt limits or an outage block us.
4. **Use ARI for every renewal, with jitter.** ARI renewals are exempt from all limits. Fall back to renewing at one third of lifetime remaining.
5. **One certificate per hub with two names:** `<hub-id>.hubs.example.com` and `*.<hub-id>.hubs.example.com`. Use the plain name as the stable origin. The wildcard costs nothing extra and leaves room for a relay name or address-in-name later.
6. **Random hub ids.** Nothing personal in the name. The id is public from day one.
7. **Never ship a shared wildcard key.**
8. **Plan for 45-day certificates and no authorization reuse by February 2028.** Every renewal will need a fresh DNS-01 round trip, so the TXT service must be reliable. A hub that was off for six weeks must renew before it can serve.
9. **State the trust model honestly in our docs:** we control the domain, so we could obtain a certificate for a hub name. The public log lets anyone check that we have not.

### At 100, 5,000 and 50,000 hubs

Arithmetic from the limits in 1.1. Renewals assumed at day 30 of a 45-day certificate.

| | 100 hubs | 5,000 hubs | 50,000 hubs |
|---|---|---|---|
| Renewals per day | about 3 | about 170 | about 1,700 |
| Binding limit | 50 new certificates per week for the whole domain: a burst of 50, then about 7 new hubs a day | The same limit, now far too low for onboarding | With the list entry, limits are per hub. With per-hub accounts there is no shared account limit. |
| Public Suffix List | Not yet. We would be declined as too small. | Apply as soon as we honestly serve thousands of users. State cookie and origin isolation as the reason, because it is the real one. Do this before asking Let's Encrypt for a domain override. | In place |
| Let's Encrypt | Default limits are enough if we add fewer than about 7 hubs a day. If a launch needs more, file the override form several weeks ahead. Expect that a small project may be refused. | Until the list entry is live at Let's Encrypt (about two to three weeks after the request in libp2p's case), onboarding is capped. Use the second issuer for overflow. | Tell Let's Encrypt who we are. Keep jitter and ARI. Consider sponsoring. |
| Second issuer | Wire it up now as a fallback, even if unused | Use for overflow during the transition | Keep as a live standby |
| If we instead used one shared ACME account | Fine | 300 orders per 3 hours is fine | 1,700 renewals a day is about 210 per 3 hours, under the 300 limit even without the ARI exemption, but onboarding bursts would need an account override |

Before the list entry exists, protect hubs from each other's cookies by using `__Host-` prefixed cookies and never setting a cookie for the parent domain. (My recommendation.)

### How the hub should detect a blocking router

1. On start, on network change and daily, run the test in 2.4: own name, a fixed canary and a public control.
2. Send each query three ways: through the operating system, straight to the default gateway on port 53, and straight to each DNS server from the DHCP lease.
3. Test IPv4 and IPv6 answers separately.
4. Classify: expected address means clear. Empty answer, timeout, NXDOMAIN, `0.0.0.0`, REFUSED or SERVFAIL while the control works means blocked. Control failing means "DNS problem", not "blocked".
5. Report the result to our service over the existing relay connection, with which resolver failed and how.
6. Treat the result as a strong hint, not proof. Devices using DNS over HTTPS or their own DNS settings may differ. The phone app should run its own lookup and report too.
7. Try to identify the router (for example the resolver's version string, as seen in the measurement) to pick the right instructions. This is best-effort.

### Fallback when the name is blocked

In order:

1. **Automatic: switch that hub's name to the relay.** Our DNS answers that hub's name with the relay's public address. The relay forwards the raw TLS connection to the hub over the connection the hub already holds. TLS still ends on the hub, with the hub's key. The name, certificate and browser origin stay the same, and it also works away from home. The cost is that traffic leaves the home network (still encrypted end to end) and uses our bandwidth. Nabu Casa's remote access works on this principle. Switch modes rarely, because flipping between public and private answers mid-session can trigger Chrome's prompt (3.1).
2. **Tell the user how to fix the router**, using the table in 2.2, so the hub can go back to direct mode. Show the exact line for OpenWrt, pfSense, OPNsense, FRITZ!Box, Pi-hole and AdGuard Home. For Google Wifi, BT and Virgin hubs, say plainly that there is no per-domain setting and offer "change the DNS server" or "stay on relay".
3. **Phone app: connect by address, verify by name.** The app learns the hub's address through the relay, connects to it directly and checks the certificate against the hub name. Router DNS no longer matters. Declare the iOS local network usage string and request Android's `ACCESS_LOCAL_NETWORK` when targeting Android 17.
4. **Do not fall back to plain HTTP or to a click-through certificate** for the main app. Plain HTTP loses `crypto.subtle` and service workers. Click-through loses service workers and passkeys in Chrome.
5. **Serve the web app from the hub's own origin.** A cloud-hosted page that calls the hub would hit Chrome's prompt, and soon Firefox's. A top-level link or redirect from our cloud site to the hub name is fine today.

---

## What remains unverified

Certificates:

- The questions and approval criteria on Let's Encrypt's override form.
- How Plex manages Let's Encrypt limits today without a Public Suffix List entry.
- The current production status of DNS-PERSIST-01.
- The reported trust-store problem with Let's Encrypt's new root hierarchy (forum reports only).
- The 24-hour revocation rule for compromised keys (Baseline Requirements not opened).
- Synology's exact issuance flow (the knowledge-base page did not render).
- Nabu Casa's own description of its remote access (support site returned HTTP 403). The source code was read.
- Per-domain limits at Google Trust Services and any numeric limits at ZeroSSL.
- Other free ACME issuers (SSL.com, Actalis).

Routers and resolvers:

- Plex's support article on DNS rebinding (HTTP 403). No Plex-authored router list was read.
- FRITZ!Box menu path and field name, from AVM's own page (read only through a search summary).
- OpenWrt's web-interface labels (the wiki refused the fetch). The config file names are verified.
- OPNsense's default state.
- ASUS's default state, from ASUS itself.
- TP-Link, Sky, German ISP routers, Dutch ISP routers: nothing found.
- BT, Virgin Media, Vodafone UK, Plusnet: forum reports only, several pages unreadable.
- UniFi's current behaviour and any setting name.
- The exact blocked answer on Google Wifi, FRITZ!Box (timeout is AVM's description of the symptom), AdGuard Home and NextDNS.
- NextDNS's current default for new profiles.
- Why the measured router passed a private IPv6 answer when dnsmasq's manual says it should be covered.
- The measurements come from one network on one day.

Browsers and phones:

- Whether WebSocket gating shipped to stable in Chrome 147.
- That Chrome leaves a local page calling its own origin alone, confirmed by a test. It follows from the specification, but I did not run a browser test.
- Firefox's rollout version and its behaviour for local pages (support article did not load).
- Safari's plans and timing.
- Whether an in-app web view on iOS needs the local network permission (Apple's note and Apple's engineer disagree).
- That Chrome and Firefox on macOS 15 and later show the local network prompt for home-network addresses.
- `isSecureContext`, `crypto.subtle` and service worker behaviour after a certificate click-through in current Chrome, Firefox and Safari. Needs a device test matrix.

/*
 * Makes pairing's vectors from ESP-IDF's own code (docs/m3-design.md section 5; P3's brief, item 4).
 *
 * The board is ESP-IDF v6.1.1's protocomm with security 2, compiled for this Mac: protocomm.c,
 * security2.c (included below, unchanged, so the harness can set the session's counter for the
 * counter's edge cases), esp_srp.c and esp_srp_mpi.c, the generated protobuf-c files and protobuf-c
 * itself, over Mbed TLS as ESP-IDF vendors it. Every write is protocomm_req_handle(), which is what
 * protocomm_nimble.c calls when a characteristic is written; its answer is what a read of that
 * characteristic then returns, and a non-zero result is the write refused with ATT error 0x04.
 *
 * The phone is client.c, the harness's own SRP6a client: ESP-IDF's server checks each proof it
 * sends, so the recorded exchanges are ones ESP-IDF accepted. Random values (the salt, b, the
 * session id, a) are fixed: SHA-256 of "hsn-vector/pairing/<name>", fed to ESP-IDF's
 * esp_fill_random() and psa_generate_random() in the order its code draws them, and checked used.
 *
 * Usage: harness <output directory> <ESP-IDF version> <ESP-IDF commit> <Mbed TLS commit>
 *        <protobuf-c commit>. make-vectors.sh builds and runs it.
 */
#define MBEDTLS_DECLARE_PRIVATE_IDENTIFIERS
#define psa_generate_random harness_psa_generate_random
#include "security2.c"
#undef psa_generate_random

#include <stdarg.h>
#include <stdbool.h>

#include "client.h"
#include "protocomm.h"
#include "protocomm_priv.h"
#include "published.h"

#define SESSION 1
#define MAX_STEPS 16
#define MAX_MESSAGE 1024

/* ----- ESP-IDF's environment, on the host ----- */

char harness_last_log[256];
static const char *last_event;

esp_err_t esp_event_post(esp_event_base_t base, int32_t id, const void *data, size_t size,
                         uint32_t ticks)
{
    (void)data;
    (void)size;
    (void)ticks;
    if (base == PROTOCOMM_SECURITY_SESSION_EVENT) {
        last_event = id == PROTOCOMM_SECURITY_SESSION_SETUP_OK                  ? "setupOk"
                     : id == PROTOCOMM_SECURITY_SESSION_INVALID_SECURITY_PARAMS ? "invalidSecurityParams"
                     : id == PROTOCOMM_SECURITY_SESSION_CREDENTIALS_MISMATCH    ? "credentialsMismatch"
                                                                                : "other";
    }
    return ESP_OK;
}

static uint8_t rng[256];
static size_t rng_len, rng_pos;

static void fail(const char *what)
{
    fprintf(stderr, "harness: %s\n", what);
    exit(2);
}

/* While a board script is recorded, the values the board draws (b, the session id) and the
 * phone's a, so the script can be replayed without the harness's seeds. */
typedef struct {
    uint8_t bytes[32];
    size_t len;
} draw_t;
static draw_t *record_draws, *record_privates;
static int *record_draw_count, *record_private_count;

static void record(draw_t *list, int *count, const uint8_t *bytes, size_t len)
{
    if (list && *count < 8 && len <= 32) {
        memcpy(list[*count].bytes, bytes, len);
        list[*count].len = len;
        (*count)++;
    }
}

static void rng_push(const uint8_t *bytes, size_t len)
{
    record(record_draws, record_draw_count, bytes, len);
    if (rng_len + len > sizeof(rng)) {
        fail("random queue full");
    }
    memcpy(rng + rng_len, bytes, len);
    rng_len += len;
}

static void rng_expect_used(void)
{
    if (rng_pos != rng_len) {
        fail("a fixed random value was not drawn where expected");
    }
    rng_pos = rng_len = 0;
}

void esp_fill_random(void *buf, size_t len)
{
    if (rng_pos + len > rng_len) {
        fail("ESP-IDF drew a random value the harness did not supply");
    }
    memcpy(buf, rng + rng_pos, len);
    rng_pos += len;
}

psa_status_t harness_psa_generate_random(uint8_t *out, size_t len)
{
    esp_fill_random(out, len);
    return PSA_SUCCESS;
}

/* ----- Fixed values ----- */

static void fixed(uint8_t *out, size_t len, const char *format, ...)
{
    char name[160];
    uint8_t digest[32];
    size_t digest_len = 0;
    int n = snprintf(name, sizeof name, "hsn-vector/pairing/");
    va_list args;
    va_start(args, format);
    vsnprintf(name + n, sizeof name - (size_t)n, format, args);
    va_end(args);
    psa_hash_compute(PSA_ALG_SHA_256, (const uint8_t *)name, strlen(name), digest, sizeof digest,
                     &digest_len);
    memcpy(out, digest, len);
}

/* ----- JSON ----- */

typedef struct {
    FILE *f;
    int depth;
    bool after_key;
    bool first[32];
} json_t;

static void j_newline(json_t *j)
{
    fputc('\n', j->f);
    for (int i = 0; i < j->depth; i++) {
        fputs("  ", j->f);
    }
}

static void j_prefix(json_t *j)
{
    if (j->after_key) {
        j->after_key = false;
        return;
    }
    if (j->depth > 0) {
        if (!j->first[j->depth]) {
            fputc(',', j->f);
        }
        j->first[j->depth] = false;
        j_newline(j);
    }
}

static void j_open(json_t *j, char bracket)
{
    j_prefix(j);
    fputc(bracket, j->f);
    j->depth++;
    j->first[j->depth] = true;
}

static void j_close(json_t *j, char bracket)
{
    bool empty = j->first[j->depth];
    j->depth--;
    if (!empty) {
        j_newline(j);
    }
    fputc(bracket, j->f);
}

static void j_key(json_t *j, const char *key)
{
    j_prefix(j);
    fprintf(j->f, "\"%s\": ", key);
    j->after_key = true;
}

static void j_str(json_t *j, const char *text)
{
    j_prefix(j);
    fputc('"', j->f);
    for (const char *p = text; *p; p++) {
        if (*p == '"' || *p == '\\') {
            fputc('\\', j->f);
        }
        fputc(*p, j->f);
    }
    fputc('"', j->f);
}

static void j_hex(json_t *j, const uint8_t *bytes, size_t len)
{
    j_prefix(j);
    fputc('"', j->f);
    for (size_t i = 0; i < len; i++) {
        fprintf(j->f, "%02x", bytes[i]);
    }
    fputc('"', j->f);
}

static void j_num(json_t *j, unsigned long long value)
{
    j_prefix(j);
    fprintf(j->f, "%llu", value);
}

static void j_bool(json_t *j, bool value)
{
    j_prefix(j);
    fputs(value ? "true" : "false", j->f);
}

static void j_null(json_t *j)
{
    j_prefix(j);
    fputs("null", j->f);
}

static void kv_str(json_t *j, const char *k, const char *v)
{
    j_key(j, k);
    j_str(j, v);
}

static void kv_hex(json_t *j, const char *k, const uint8_t *v, size_t len)
{
    j_key(j, k);
    j_hex(j, v, len);
}

static FILE *open_out(const char *dir, const char *name, json_t *j)
{
    char path[1024];
    snprintf(path, sizeof path, "%s/%s", dir, name);
    FILE *f = fopen(path, "w");
    if (!f) {
        fail("cannot write a vector file");
    }
    memset(j, 0, sizeof *j);
    j->f = f;
    return f;
}

static void close_out(json_t *j)
{
    fputc('\n', j->f);
    fclose(j->f);
}

/* ----- The board: protocomm with security 2, proto-ver and hsn-setup ----- */

static const uint8_t IDENTIFY[] = {0xf1, 0x01};
static const uint8_t ACCEPTED[] = {0xf1, 0x04, 0x00};
/* setup-messages.json's "provision" case. */
static const char PROVISION_HEX[] =
    "f103014d3c2b1a000102030405060708090a0b0c0d0e0fd6c23e2744a840cb60fed4ba255a9d31c961eb74c6356d6"
    "8c049b8923b61fa6ce669622e60f29fb67903fe1008b8bc99a41ae9e95628bc64f2f1b20c2d7e9f5177a3c294d446"
    "2299012404686f6d6515636f727265637420686f7273652062617474657279";
static uint8_t provision[128];
static size_t provision_len;

typedef struct {
    protocomm_t *pc;
    protocomm_security2_params_t params;
    uint8_t identity[22];
    char version[160];
    int acted;
} board_t;

static board_t *current_board;

static void unhex(uint8_t *out, size_t *len, const char *hex)
{
    size_t n = strlen(hex) / 2;
    for (size_t i = 0; i < n; i++) {
        unsigned v;
        sscanf(hex + 2 * i, "%2x", &v);
        out[i] = (uint8_t)v;
    }
    *len = n;
}

/* The setup endpoint: a scripted board's answers, the bytes of §10's setup messages. */
static esp_err_t setup_handler(uint32_t session_id, const uint8_t *in, ssize_t in_len, uint8_t **out,
                               ssize_t *out_len, void *priv)
{
    (void)session_id;
    (void)priv;
    const uint8_t *answer = NULL;
    size_t answer_len = 0;
    current_board->acted++;
    if ((size_t)in_len == sizeof IDENTIFY && memcmp(in, IDENTIFY, sizeof IDENTIFY) == 0) {
        answer = current_board->identity;
        answer_len = sizeof current_board->identity;
    } else if ((size_t)in_len == provision_len && memcmp(in, provision, provision_len) == 0) {
        answer = ACCEPTED;
        answer_len = sizeof ACCEPTED;
    } else {
        return ESP_FAIL;
    }
    *out = malloc(answer_len);
    memcpy(*out, answer, answer_len);
    *out_len = (ssize_t)answer_len;
    return ESP_OK;
}

static void board_open(board_t *bd, const uint8_t *salt, size_t salt_len, const char *verifier,
                       size_t verifier_len, uint8_t role, const uint8_t chip[6])
{
    memset(bd, 0, sizeof *bd);
    /* Identity: role, chip, firmware 1.0.0, unpaired, no hub, release build. */
    bd->identity[0] = 0xf1;
    bd->identity[1] = 0x02;
    bd->identity[2] = role;
    memcpy(bd->identity + 3, chip, 6);
    bd->identity[9] = 1;
    snprintf(bd->version, sizeof bd->version,
             "{\"v\":\"hsn-pair/1\",\"role\":%u,\"chip\":\"%02x%02x%02x%02x%02x%02x\","
             "\"firmware\":\"1.0.0\",\"sec\":2}",
             role, chip[0], chip[1], chip[2], chip[3], chip[4], chip[5]);
    bd->params.salt = (const char *)salt;
    bd->params.salt_len = (uint16_t)salt_len;
    bd->params.verifier = verifier;
    bd->params.verifier_len = (uint16_t)verifier_len;
    bd->pc = protocomm_new();
    if (!bd->pc || protocomm_set_version(bd->pc, "proto-ver", bd->version) != ESP_OK ||
        protocomm_set_security(bd->pc, "prov-session", &protocomm_security2, &bd->params) != ESP_OK ||
        protocomm_add_endpoint(bd->pc, "hsn-setup", setup_handler, NULL) != ESP_OK ||
        protocomm_open_session(bd->pc, SESSION) != ESP_OK) {
        fail("protocomm would not start");
    }
    current_board = bd;
}

static void board_close(board_t *bd)
{
    protocomm_close_session(bd->pc, SESSION);
    protocomm_delete(bd->pc);
    current_board = NULL;
}

/* The board's session state, which security2.c keeps private: for the counter's edge cases. */
static aes_gcm_iv_t *board_iv(board_t *bd)
{
    return (aes_gcm_iv_t *)((session_t *)bd->pc->sec_inst)->iv;
}

static session_t *board_session(board_t *bd)
{
    return (session_t *)bd->pc->sec_inst;
}

/* ----- Steps: one write to a characteristic and what a read then returns ----- */

typedef struct {
    const char *endpoint;
    uint8_t request[MAX_MESSAGE];
    size_t request_len;
    bool refused;
    uint8_t answer[MAX_MESSAGE];
    size_t answer_len;
    const char *event;
    char log[256];
    int acted;
    const char *note;
} step_t;

typedef struct {
    step_t steps[MAX_STEPS];
    int count;
} script_t;

static step_t *board_write(board_t *bd, script_t *sc, const char *endpoint, const uint8_t *request,
                           size_t request_len)
{
    if (sc->count >= MAX_STEPS) {
        fail("too many steps");
    }
    step_t *st = &sc->steps[sc->count++];
    memset(st, 0, sizeof *st);
    st->endpoint = endpoint;
    memcpy(st->request, request, request_len);
    st->request_len = request_len;
    harness_last_log[0] = 0;
    last_event = NULL;
    int acted_before = bd->acted;
    uint8_t *out = NULL;
    ssize_t out_len = 0;
    /* The first error the board logs is the check that refused (esp_log.h keeps only it). */
    esp_err_t ret = protocomm_req_handle(bd->pc, endpoint, SESSION, request, (ssize_t)request_len,
                                         &out, &out_len);
    snprintf(st->log, sizeof st->log, "%s", harness_last_log);
    st->refused = ret != ESP_OK;
    st->event = last_event;
    st->acted = bd->acted - acted_before;
    if (!st->refused) {
        if (out_len > MAX_MESSAGE || out_len > 512) {
            fail("an answer longer than a characteristic holds");
        }
        memcpy(st->answer, out, (size_t)out_len);
        st->answer_len = (size_t)out_len;
    }
    free(out);
    return st;
}

/* ----- The phone's messages, made with ESP-IDF's own protobuf-c descriptors ----- */

static size_t pack_session(SessionData *sd, uint8_t *out)
{
    size_t len = session_data__get_packed_size(sd);
    if (len > MAX_MESSAGE) {
        fail("message too long");
    }
    session_data__pack(sd, out);
    return len;
}

static size_t make_command0(uint8_t *out, const char *username, size_t username_len,
                            const uint8_t *pubkey, size_t pubkey_len, int sec_ver)
{
    S2SessionCmd0 cmd = S2_SESSION_CMD0__INIT;
    Sec2Payload payload = SEC2_PAYLOAD__INIT;
    SessionData sd = SESSION_DATA__INIT;
    cmd.client_username.data = (uint8_t *)username;
    cmd.client_username.len = username_len;
    cmd.client_pubkey.data = (uint8_t *)pubkey;
    cmd.client_pubkey.len = pubkey_len;
    payload.msg = SEC2_MSG_TYPE__S2Session_Command0;
    payload.payload_case = SEC2_PAYLOAD__PAYLOAD_SC0;
    payload.sc0 = &cmd;
    sd.sec_ver = (SecSchemeVersion)sec_ver;
    sd.proto_case = SESSION_DATA__PROTO_SEC2;
    sd.sec2 = &payload;
    return pack_session(&sd, out);
}

static size_t make_command1(uint8_t *out, const uint8_t *proof, size_t proof_len)
{
    S2SessionCmd1 cmd = S2_SESSION_CMD1__INIT;
    Sec2Payload payload = SEC2_PAYLOAD__INIT;
    SessionData sd = SESSION_DATA__INIT;
    cmd.client_proof.data = (uint8_t *)proof;
    cmd.client_proof.len = proof_len;
    payload.msg = SEC2_MSG_TYPE__S2Session_Command1;
    payload.payload_case = SEC2_PAYLOAD__PAYLOAD_SC1;
    payload.sc1 = &cmd;
    sd.sec_ver = SEC_SCHEME_VERSION__SecScheme2;
    sd.proto_case = SESSION_DATA__PROTO_SEC2;
    sd.sec2 = &payload;
    return pack_session(&sd, out);
}

typedef struct {
    uint8_t B[384];
    size_t B_len;
    uint8_t salt[64];
    size_t salt_len;
} response0_t;

static void read_response0(const step_t *st, response0_t *r)
{
    SessionData *sd = session_data__unpack(NULL, st->answer_len, st->answer);
    if (!sd || !sd->sec2 || sd->sec2->payload_case != SEC2_PAYLOAD__PAYLOAD_SR0 ||
        sd->sec2->sr0->status != STATUS__Success || sd->sec2->sr0->device_pubkey.len > 384) {
        fail("response 0 is not what security2.c makes");
    }
    memcpy(r->B, sd->sec2->sr0->device_pubkey.data, sd->sec2->sr0->device_pubkey.len);
    r->B_len = sd->sec2->sr0->device_pubkey.len;
    memcpy(r->salt, sd->sec2->sr0->device_salt.data, sd->sec2->sr0->device_salt.len);
    r->salt_len = sd->sec2->sr0->device_salt.len;
    session_data__free_unpacked(sd, NULL);
}

static void read_response1(const step_t *st, uint8_t proof[64], uint8_t nonce[12])
{
    SessionData *sd = session_data__unpack(NULL, st->answer_len, st->answer);
    if (!sd || !sd->sec2 || sd->sec2->payload_case != SEC2_PAYLOAD__PAYLOAD_SR1 ||
        sd->sec2->sr1->device_proof.len != 64 || sd->sec2->sr1->device_nonce.len != 12) {
        fail("response 1 is not what security2.c makes");
    }
    memcpy(proof, sd->sec2->sr1->device_proof.data, 64);
    memcpy(nonce, sd->sec2->sr1->device_nonce.data, 12);
    session_data__free_unpacked(sd, NULL);
}

/* ----- The phone's AES-256-GCM, its own counter ----- */

typedef struct {
    psa_key_id_t key;
    uint8_t key_bytes[32];
    uint8_t iv[12];
} phone_aead_t;

static void phone_aead_start(phone_aead_t *p, const uint8_t K[64], const uint8_t nonce[12])
{
    psa_key_attributes_t attr = PSA_KEY_ATTRIBUTES_INIT;
    psa_set_key_type(&attr, PSA_KEY_TYPE_AES);
    psa_set_key_bits(&attr, 256);
    psa_set_key_usage_flags(&attr, PSA_KEY_USAGE_ENCRYPT | PSA_KEY_USAGE_DECRYPT);
    psa_set_key_algorithm(&attr, PSA_ALG_GCM);
    memcpy(p->key_bytes, K, 32);
    if (psa_import_key(&attr, K, 32, &p->key) != PSA_SUCCESS) {
        fail("key import");
    }
    memcpy(p->iv, nonce, 12);
}

static void phone_iv_set(phone_aead_t *p, uint32_t counter)
{
    uint32_t be = htobe32(counter);
    memcpy(p->iv + 8, &be, 4);
}

static uint32_t phone_iv_counter(const phone_aead_t *p)
{
    uint32_t be;
    memcpy(&be, p->iv + 8, 4);
    return be32toh(be);
}

static size_t phone_seal(phone_aead_t *p, const uint8_t *in, size_t len, uint8_t *out)
{
    size_t out_len = 0;
    if (psa_aead_encrypt(p->key, PSA_ALG_GCM, p->iv, 12, NULL, 0, in, len, out, len + 16,
                         &out_len) != PSA_SUCCESS) {
        fail("seal");
    }
    phone_iv_set(p, phone_iv_counter(p) + 1);
    return out_len;
}

static size_t phone_open(phone_aead_t *p, const uint8_t *in, size_t len, uint8_t *out)
{
    size_t out_len = 0;
    if (psa_aead_decrypt(p->key, PSA_ALG_GCM, p->iv, 12, NULL, 0, in, len, out, len - 16,
                         &out_len) != PSA_SUCCESS) {
        fail("the board's answer did not open");
    }
    phone_iv_set(p, phone_iv_counter(p) + 1);
    return out_len;
}

/* ----- SRP cases ----- */

#define MAX_CASES 8

typedef struct {
    char name[128];
    const char *slug;
    const char *username;
    char password[32];
    uint8_t role;
    uint8_t chip[6];
    uint8_t salt[16];
    char *verifier;
    int verifier_len;
    bool published;
    uint8_t b[32];
    uint8_t a[32];
    uint8_t sid[8];
    /* Results. */
    client_t cl;
    response0_t r0;
    script_t script;
    uint8_t device_proof[64];
    uint8_t nonce[12];
    uint8_t board_key[64];
} srp_case_t;

static srp_case_t cases[MAX_CASES];
static int case_count;

static void make_verifier(srp_case_t *c)
{
    if (c->published) {
        memcpy(c->salt, PUBLISHED_SALT, sizeof c->salt);
        c->verifier = malloc(sizeof PUBLISHED_VERIFIER);
        memcpy(c->verifier, PUBLISHED_VERIFIER, sizeof PUBLISHED_VERIFIER);
        c->verifier_len = (int)sizeof PUBLISHED_VERIFIER;
        return;
    }
    char *salt_out = NULL;
    /* The salt is the code's, made once; not a draw of the session. */
    draw_t *saved = record_draws;
    record_draws = NULL;
    rng_push(c->salt, sizeof c->salt);
    record_draws = saved;
    if (esp_srp_gen_salt_verifier(c->username, (int)strlen(c->username), c->password,
                                  (int)strlen(c->password), &salt_out, (int)sizeof c->salt,
                                  &c->verifier, &c->verifier_len) != ESP_OK) {
        fail("esp_srp_gen_salt_verifier");
    }
    rng_expect_used();
    /* esp_srp keeps the salt's minimal big-endian form: equal to ours only when its first byte
     * is not zero, which every case's salt is chosen to have. */
    if (memcmp(salt_out, c->salt, sizeof c->salt) != 0) {
        fail("the salt came back changed");
    }
    free(salt_out);
}

/* Command 0 and response 0 on an open board; the board draws b. */
static step_t *exchange0(board_t *bd, srp_case_t *c)
{
    uint8_t message[MAX_MESSAGE];
    if (client_start(&c->cl, c->a) != 0) {
        fail("client_start");
    }
    record(record_privates, record_private_count, c->a, sizeof c->a);
    size_t len = make_command0(message, c->username, strlen(c->username), c->cl.A, sizeof c->cl.A,
                               2);
    rng_push(c->b, sizeof c->b);
    step_t *st = board_write(bd, &c->script, "prov-session", message, len);
    rng_expect_used();
    if (st->refused) {
        fail(st->log);
    }
    read_response0(st, &c->r0);
    return st;
}

/* Command 1 and response 1; the board draws the session id. */
static step_t *exchange1(board_t *bd, srp_case_t *c, const char *password)
{
    uint8_t message[MAX_MESSAGE];
    if (client_proof(&c->cl, c->username, password, c->r0.salt, c->r0.salt_len, c->r0.B,
                     c->r0.B_len) != 0) {
        fail("client_proof");
    }
    size_t len = make_command1(message, c->cl.M1, sizeof c->cl.M1);
    bool right = strcmp(password, c->password) == 0;
    if (right) {
        rng_push(c->sid, sizeof c->sid);
    }
    step_t *st = board_write(bd, &c->script, "prov-session", message, len);
    rng_expect_used();
    if (right) {
        if (st->refused) {
            fail(st->log);
        }
        read_response1(st, c->device_proof, c->nonce);
        if (memcmp(c->device_proof, c->cl.AMK, 64) != 0) {
            fail("the board's proof is not the client's AMK");
        }
        memcpy(c->board_key, board_session(bd)->session_key, 64);
        if (memcmp(c->board_key, c->cl.K, 64) != 0) {
            fail("the board's session key is not the client's");
        }
    }
    return st;
}

static void case_seeds(srp_case_t *c, int b_index, int a_index, int salt_index)
{
    fixed(c->salt, sizeof c->salt, "%s/salt/%d", c->slug, salt_index);
    fixed(c->b, sizeof c->b, "%s/b/%d", c->slug, b_index);
    fixed(c->a, sizeof c->a, "%s/a/%d", c->slug, a_index);
    fixed(c->sid, sizeof c->sid, "%s/session-id", c->slug);
}

static srp_case_t *new_case(const char *name, const char *slug, const char *username,
                            const char *password, uint8_t role)
{
    if (case_count >= MAX_CASES) {
        fail("too many cases");
    }
    srp_case_t *c = &cases[case_count++];
    memset(c, 0, sizeof *c);
    snprintf(c->name, sizeof c->name, "%s", name);
    c->slug = slug;
    c->username = username;
    snprintf(c->password, sizeof c->password, "%s", password);
    c->role = role;
    fixed(c->chip, sizeof c->chip, "%s/chip", slug);
    return c;
}

/* Runs one case's handshake; `want` checks the case's special property after response 0 and the
 * client's S, or is NULL. Searches the index of b, a or the salt until it holds. */
typedef bool (*want_t)(const srp_case_t *c);

static void run_case(srp_case_t *c, char vary, want_t want)
{
    for (int i = 0; i < 4096; i++) {
        /* 'x' varies all three together. */
        case_seeds(c, vary == 'b' || vary == 'x' ? i : 0, vary == 'a' || vary == 'x' ? i : 0,
                   vary == 's' || vary == 'x' ? i : 0);
        if (!c->published && c->salt[0] == 0) {
            continue;
        }
        make_verifier(c);
        board_t bd;
        board_open(&bd, c->salt, sizeof c->salt, c->verifier, (size_t)c->verifier_len, c->role,
                   c->chip);
        c->script.count = 0;
        exchange0(&bd, c);
        if (client_proof(&c->cl, c->username, c->password, c->r0.salt, c->r0.salt_len, c->r0.B,
                         c->r0.B_len) != 0) {
            fail("client_proof");
        }
        if (want && !want(c)) {
            board_close(&bd);
            free(c->verifier);
            continue;
        }
        exchange1(&bd, c, c->password);
        board_close(&bd);
        return;
    }
    fprintf(stderr, "harness: case %s\n", c->name);
    fail("no seed gave the case's property");
}

static bool short_b(const srp_case_t *c) { return c->r0.B_len == 383; }
static bool short_s(const srp_case_t *c) { return c->cl.s_len == 383; }
static bool short_a(const srp_case_t *c) { return c->cl.A[0] == 0; }
static bool short_v(const srp_case_t *c) { return c->verifier_len == 383; }
static bool long_all(const srp_case_t *c)
{
    return c->r0.B_len == 384 && c->cl.s_len == 384 && c->cl.A[0] != 0 && c->verifier_len == 384;
}

/* ----- Writing the files ----- */

static char source[1024];

static void write_srp_file(const char *dir)
{
    json_t j;
    open_out(dir, "pairing-srp.json", &j);
    j_open(&j, '{');
    j_key(&j, "schemaVersion");
    j_num(&j, 1);
    kv_str(&j, "description",
           "SRP6a as ESP-IDF's esp_srp.c computes it for protocomm security 2: RFC 5054's 3,072-bit "
           "group (g = 5), SHA-512 as H. Salt and verifier from esp_srp_gen_salt_verifier (16-byte "
           "salt): x = H(salt | H(username ':' password)), verifier = g^x mod N, in its minimal "
           "big-endian bytes. k = H(N | PAD(g)). The client's A = g^a mod N is sent as 384 bytes. "
           "The board's B = (k v + g^b) mod N, in its minimal bytes (so 383 when its first byte "
           "would be zero), with b of 32 bytes. u = H(PAD(A) | PAD(B)), each padded to 384 bytes. "
           "S = (A v^u)^b = (B - k g^x)^(a + u x) mod N, and sessionKey K = H(S) over S's minimal "
           "bytes. clientProof M = H((H(N) xor H(PAD(g))) | H(username) | salt | A | B | K), with A "
           "and B exactly as sent; deviceProof = H(A | M | K). Private values are big-endian. Made by "
           "running ESP-IDF's own code as the board, with these fixed values, against a second "
           "client whose proofs that code accepted; each case also names the property it pins.");
    kv_str(&j, "source", source);
    j_key(&j, "cases");
    j_open(&j, '[');
    for (int i = 0; i < case_count; i++) {
        srp_case_t *c = &cases[i];
        j_open(&j, '{');
        kv_str(&j, "name", c->name);
        kv_str(&j, "username", c->username);
        kv_str(&j, "password", c->password);
        kv_hex(&j, "salt", c->salt, sizeof c->salt);
        kv_hex(&j, "verifier", (const uint8_t *)c->verifier, (size_t)c->verifier_len);
        kv_hex(&j, "clientPrivate", c->a, sizeof c->a);
        kv_hex(&j, "clientPublic", c->cl.A, sizeof c->cl.A);
        kv_hex(&j, "devicePrivate", c->b, sizeof c->b);
        kv_hex(&j, "devicePublic", c->r0.B, c->r0.B_len);
        kv_hex(&j, "u", c->cl.u, sizeof c->cl.u);
        kv_hex(&j, "sessionKey", c->board_key, sizeof c->board_key);
        kv_hex(&j, "clientProof", c->cl.M1, sizeof c->cl.M1);
        kv_hex(&j, "deviceProof", c->device_proof, sizeof c->device_proof);
        j_close(&j, '}');
    }
    j_close(&j, ']');
    j_close(&j, '}');
    close_out(&j);
}

typedef struct {
    const char *direction;
    uint8_t nonce[12];
    uint8_t plaintext[MAX_MESSAGE];
    size_t plaintext_len;
    uint8_t sealed[MAX_MESSAGE];
    size_t sealed_len;
} sealed_t;

typedef struct {
    const char *name;
    srp_case_t *srp;
    sealed_t messages[8];
    int count;
} session_case_t;

/* One setup message through the board: sealed by the phone, opened, answered and sealed by the
 * board, opened by the phone. */
static step_t *setup_exchange(board_t *bd, script_t *sc, phone_aead_t *p, session_case_t *out,
                              const uint8_t *plaintext, size_t len)
{
    sealed_t *up = out ? &out->messages[out->count++] : NULL;
    sealed_t local_up, local_down;
    if (!up) {
        up = &local_up;
    }
    up->direction = "toBoard";
    memcpy(up->nonce, p->iv, 12);
    memcpy(up->plaintext, plaintext, len);
    up->plaintext_len = len;
    up->sealed_len = phone_seal(p, plaintext, len, up->sealed);
    step_t *st = board_write(bd, sc, "hsn-setup", up->sealed, up->sealed_len);
    if (st->refused) {
        return st;
    }
    sealed_t *down = out ? &out->messages[out->count++] : &local_down;
    down->direction = "toPhone";
    memcpy(down->nonce, p->iv, 12);
    memcpy(down->sealed, st->answer, st->answer_len);
    down->sealed_len = st->answer_len;
    down->plaintext_len = phone_open(p, st->answer, st->answer_len, down->plaintext);
    return st;
}

/* A whole pairing on one case: proto-ver, the handshake, then the setup messages. */
static void whole_pairing(srp_case_t *c, session_case_t *sc, bool provision_too)
{
    board_t bd;
    make_verifier(c);
    board_open(&bd, c->salt, sizeof c->salt, c->verifier, (size_t)c->verifier_len, c->role, c->chip);
    c->script.count = 0;
    const char *label = "hsn-pair/1";
    board_write(&bd, &c->script, "proto-ver", (const uint8_t *)label, strlen(label));
    exchange0(&bd, c);
    exchange1(&bd, c, c->password);
    phone_aead_t p;
    phone_aead_start(&p, c->cl.K, c->nonce);
    sc->srp = c;
    sc->count = 0;
    if (setup_exchange(&bd, &c->script, &p, sc, IDENTIFY, sizeof IDENTIFY)->refused) {
        fail("Identify refused");
    }
    if (provision_too &&
        setup_exchange(&bd, &c->script, &p, sc, provision, provision_len)->refused) {
        fail("Provision refused");
    }
    board_close(&bd);
    free(c->verifier);
}

static void write_steps(json_t *j, const script_t *sc)
{
    j_key(j, "steps");
    j_open(j, '[');
    for (int i = 0; i < sc->count; i++) {
        const step_t *st = &sc->steps[i];
        j_open(j, '{');
        kv_str(j, "endpoint", st->endpoint);
        kv_hex(j, "request", st->request, st->request_len);
        j_key(j, "answer");
        if (st->refused) {
            j_null(j);
        } else {
            j_hex(j, st->answer, st->answer_len);
        }
        j_key(j, "event");
        if (st->event) {
            j_str(j, st->event);
        } else {
            j_null(j);
        }
        j_key(j, "boardLog");
        if (st->refused) {
            j_str(j, st->log);
        } else {
            j_null(j);
        }
        j_key(j, "setupHandlerRan");
        j_bool(j, st->acted > 0);
        if (st->note) {
            kv_str(j, "note", st->note);
        }
        j_close(j, '}');
    }
    j_close(j, ']');
}

static void write_security2_file(const char *dir, session_case_t *sessions, int count)
{
    json_t j;
    open_out(dir, "pairing-security2.json", &j);
    j_open(&j, '{');
    j_key(&j, "schemaVersion");
    j_num(&j, 1);
    kv_str(&j, "description",
           "Whole protocomm security 2 exchanges as ESP-IDF's security2.c and protocomm.c make them, "
           "for the SRP case named by srpCase. Every message is a protobuf SessionData (session.proto"
           ": sec_ver = 2 as field 2, sec2 as field 12) holding a Sec2Payload (sec2.proto: msg as "
           "field 1, then sc0 20, sr0 21, sc1 22 or sr1 23), proto3, so a zero msg or status is "
           "left out. command0 (S2SessionCmd0: client_username 1, client_pubkey 2) and command1 "
           "(S2SessionCmd1: client_proof 1) are written to prov-session; response0 (S2SessionResp0: "
           "status 1, device_pubkey 2, device_salt 3) and response1 (S2SessionResp1: status 1, "
           "device_proof 2, device_nonce 3) are what a read of it then returns. nonce is response "
           "1's device_nonce: the board's 8-byte session id, then a 32-bit big-endian counter of 1. "
           "After it, each setup message is sealed with AES-256-GCM under the first 32 bytes of K, "
           "no associated data, a 16-byte tag after the ciphertext. Both directions share the one "
           "counter, stepped after every message: the request to the board uses the counter, its "
           "answer the next. Requests go to hsn-setup; the answer is what a read returns.");
    kv_str(&j, "source", source);
    j_key(&j, "cases");
    j_open(&j, '[');
    for (int i = 0; i < count; i++) {
        session_case_t *s = &sessions[i];
        srp_case_t *c = s->srp;
        const step_t *steps = c->script.steps;
        j_open(&j, '{');
        kv_str(&j, "name", s->name);
        kv_str(&j, "srpCase", c->name);
        /* steps: proto-ver, command 0, command 1, then the setup messages. */
        kv_hex(&j, "command0", steps[1].request, steps[1].request_len);
        kv_hex(&j, "response0", steps[1].answer, steps[1].answer_len);
        kv_hex(&j, "command1", steps[2].request, steps[2].request_len);
        kv_hex(&j, "response1", steps[2].answer, steps[2].answer_len);
        kv_hex(&j, "nonce", c->nonce, sizeof c->nonce);
        j_key(&j, "messages");
        j_open(&j, '[');
        for (int m = 0; m < s->count; m++) {
            sealed_t *msg = &s->messages[m];
            j_open(&j, '{');
            kv_str(&j, "direction", msg->direction);
            kv_hex(&j, "nonce", msg->nonce, 12);
            kv_hex(&j, "plaintext", msg->plaintext, msg->plaintext_len);
            kv_hex(&j, "sealed", msg->sealed, msg->sealed_len);
            j_close(&j, '}');
        }
        j_close(&j, ']');
        j_close(&j, '}');
    }
    j_close(&j, ']');
    j_close(&j, '}');
    close_out(&j);
}

/* ----- The board's scripts: whole pairings and refusals ----- */

typedef struct {
    char name[200];
    const char *srp_case;
    const char *wrong_password;
    script_t script;
    draw_t draws[8];
    int draw_count;
    draw_t privates[8];
    int private_count;
} board_script_t;

#define MAX_SCRIPTS 16
static board_script_t scripts[MAX_SCRIPTS];
static int script_count;

static board_script_t *new_script(const char *name, const srp_case_t *c)
{
    board_script_t *s = &scripts[script_count++];
    memset(s, 0, sizeof *s);
    snprintf(s->name, sizeof s->name, "%s", name);
    s->srp_case = c->name;
    record_draws = s->draws;
    record_draw_count = &s->draw_count;
    record_privates = s->privates;
    record_private_count = &s->private_count;
    return s;
}

/* Opens a board for case c; the handshake to the open session, recorded into s. */
static void open_session(board_t *bd, srp_case_t *c, board_script_t *s, phone_aead_t *p)
{
    make_verifier(c);
    board_open(bd, c->salt, sizeof c->salt, c->verifier, (size_t)c->verifier_len, c->role, c->chip);
    srp_case_t copy = *c;
    copy.script.count = 0;
    exchange0(bd, &copy);
    exchange1(bd, &copy, c->password);
    for (int i = 0; i < copy.script.count; i++) {
        s->script.steps[s->script.count++] = copy.script.steps[i];
    }
    if (p) {
        phone_aead_start(p, copy.cl.K, copy.nonce);
    }
}

static void close_session(board_t *bd, srp_case_t *c)
{
    board_close(bd);
    free(c->verifier);
}

static void refusal_scripts(srp_case_t *c, const char *wrong)
{
    board_t bd;
    phone_aead_t p;
    uint8_t message[MAX_MESSAGE];
    uint8_t pub[400];
    step_t *st;

    /* The whole pairing, proto-ver first. */
    {
        board_script_t *s = new_script("a whole pairing: proto-ver, the handshake, Identify, Provision", c);
        make_verifier(c);
        board_open(&bd, c->salt, sizeof c->salt, c->verifier, (size_t)c->verifier_len, c->role,
                   c->chip);
        const char *label = "hsn-pair/1";
        board_write(&bd, &s->script, "proto-ver", (const uint8_t *)label, strlen(label))->note =
            "proto-ver answers its fixed text whatever is written; the phone writes the label";
        srp_case_t copy = *c;
        copy.script.count = 0;
        exchange0(&bd, &copy);
        exchange1(&bd, &copy, c->password);
        for (int i = 0; i < copy.script.count; i++) {
            s->script.steps[s->script.count++] = copy.script.steps[i];
        }
        phone_aead_start(&p, copy.cl.K, copy.nonce);
        setup_exchange(&bd, &s->script, &p, NULL, IDENTIFY, sizeof IDENTIFY);
        setup_exchange(&bd, &s->script, &p, NULL, provision, provision_len);
        close_session(&bd, c);
    }

    /* A wrong code: command 1 refused; then the right code on the same connection. */
    {
        board_script_t *s =
            new_script("a wrong code: command 1 is refused; command 0 again on the same "
                       "connection starts over, and the right code opens the session",
                       c);
        s->wrong_password = wrong;
        make_verifier(c);
        board_open(&bd, c->salt, sizeof c->salt, c->verifier, (size_t)c->verifier_len, c->role,
                   c->chip);
        srp_case_t copy = *c;
        copy.script.count = 0;
        exchange0(&bd, &copy);
        st = exchange1(&bd, &copy, wrong);
        if (!st->refused) {
            fail("a wrong code was accepted");
        }
        st->note = "the wrong code's proof: refused, and nothing more happens on this attempt";
        /* The retry draws a new b; the phone a new a. */
        fixed(copy.b, sizeof copy.b, "%s/retry/b", c->slug);
        fixed(copy.a, sizeof copy.a, "%s/retry/a", c->slug);
        exchange0(&bd, &copy)->note = "command 0 again: the board restarts the session";
        exchange1(&bd, &copy, c->password);
        for (int i = 0; i < copy.script.count; i++) {
            s->script.steps[s->script.count++] = copy.script.steps[i];
        }
        phone_aead_start(&p, copy.cl.K, copy.nonce);
        setup_exchange(&bd, &s->script, &p, NULL, IDENTIFY, sizeof IDENTIFY);
        close_session(&bd, c);
    }

    /* Public values the board refuses. */
    struct {
        const char *name;
        int kind;
    } bad_a[] = {
        {"A = 0 (384 zero bytes): refused, RFC 5054 2.5.4", 0},
        {"A = N: refused, A mod N is 0", 1},
        {"A of 383 bytes: refused, security 2 takes exactly 384", 2},
        {"an empty user name: refused", 3},
        {"security version 1 in SessionData: refused", 4},
    };
    for (size_t k = 0; k < sizeof bad_a / sizeof bad_a[0]; k++) {
        board_script_t *s = new_script(bad_a[k].name, c);
        make_verifier(c);
        board_open(&bd, c->salt, sizeof c->salt, c->verifier, (size_t)c->verifier_len, c->role,
                   c->chip);
        size_t pub_len = 384;
        memset(pub, 0, sizeof pub);
        if (bad_a[k].kind == 1) {
            memcpy(pub, client_group_n(), 384);
        }
        if (bad_a[k].kind == 2 || bad_a[k].kind == 3 || bad_a[k].kind == 4) {
            client_t cl;
            client_start(&cl, c->a);
            record(record_privates, record_private_count, c->a, sizeof c->a);
            memcpy(pub, cl.A, 384);
        }
        if (bad_a[k].kind == 2) {
            pub_len = 383;
        }
        const char *user = bad_a[k].kind == 3 ? "" : c->username;
        size_t len = make_command0(message, user, strlen(user), pub, pub_len,
                                   bad_a[k].kind == 4 ? 1 : 2);
        /* Only A = 0 and A = N reach the point where the board draws b. */
        if (bad_a[k].kind <= 1) {
            rng_push(c->b, sizeof c->b);
        }
        st = board_write(&bd, &s->script, "prov-session", message, len);
        rng_expect_used();
        if (!st->refused) {
            fail("a bad command 0 was accepted");
        }
        close_session(&bd, c);
    }

    /* Out of order, and of the wrong size. */
    {
        board_script_t *s = new_script("command 1 before command 0: refused", c);
        make_verifier(c);
        board_open(&bd, c->salt, sizeof c->salt, c->verifier, (size_t)c->verifier_len, c->role,
                   c->chip);
        uint8_t proof[64];
        memset(proof, 0x5a, sizeof proof);
        size_t len = make_command1(message, proof, sizeof proof);
        if (!board_write(&bd, &s->script, "prov-session", message, len)->refused) {
            fail("command 1 first was accepted");
        }
        close_session(&bd, c);
    }
    {
        board_script_t *s = new_script("a client proof of 63 bytes: refused", c);
        make_verifier(c);
        board_open(&bd, c->salt, sizeof c->salt, c->verifier, (size_t)c->verifier_len, c->role,
                   c->chip);
        srp_case_t copy = *c;
        copy.script.count = 0;
        exchange0(&bd, &copy);
        client_proof(&copy.cl, copy.username, copy.password, copy.r0.salt, copy.r0.salt_len,
                     copy.r0.B, copy.r0.B_len);
        size_t len = make_command1(message, copy.cl.M1, 63);
        if (!board_write(&bd, &copy.script, "prov-session", message, len)->refused) {
            fail("a short proof was accepted");
        }
        for (int i = 0; i < copy.script.count; i++) {
            s->script.steps[s->script.count++] = copy.script.steps[i];
        }
        close_session(&bd, c);
    }
    {
        board_script_t *s = new_script("a setup message before the session is open: refused", c);
        make_verifier(c);
        board_open(&bd, c->salt, sizeof c->salt, c->verifier, (size_t)c->verifier_len, c->role,
                   c->chip);
        if (!board_write(&bd, &s->script, "hsn-setup", IDENTIFY, sizeof IDENTIFY)->refused) {
            fail("a setup message without a session was accepted");
        }
        close_session(&bd, c);
    }

    /* Sealed requests changed, replayed and reordered. */
    {
        board_script_t *s = new_script(
            "a sealed request with one bit changed: refused, the counter does not move, and the "
            "request intact is then accepted",
            c);
        open_session(&bd, c, s, &p);
        uint8_t sealed[MAX_MESSAGE];
        uint32_t counter = phone_iv_counter(&p);
        size_t len = phone_seal(&p, IDENTIFY, sizeof IDENTIFY, sealed);
        sealed[0] ^= 0x01;
        st = board_write(&bd, &s->script, "hsn-setup", sealed, len);
        if (!st->refused) {
            fail("a changed request was accepted");
        }
        sealed[0] ^= 0x01;
        phone_iv_set(&p, counter);
        setup_exchange(&bd, &s->script, &p, NULL, IDENTIFY, sizeof IDENTIFY);
        close_session(&bd, c);
    }
    {
        board_script_t *s = new_script(
            "a sealed request sent again after its answer: refused, its counter is past", c);
        open_session(&bd, c, s, &p);
        setup_exchange(&bd, &s->script, &p, NULL, IDENTIFY, sizeof IDENTIFY);
        const step_t *sent = &s->script.steps[s->script.count - 1];
        uint8_t again[MAX_MESSAGE];
        size_t again_len = sent->request_len;
        memcpy(again, sent->request, again_len);
        if (!board_write(&bd, &s->script, "hsn-setup", again, again_len)->refused) {
            fail("a replayed request was accepted");
        }
        close_session(&bd, c);
    }
    {
        board_script_t *s = new_script(
            "two sealed requests sent in the wrong order: the later one is refused, then both are "
            "accepted in order",
            c);
        open_session(&bd, c, s, &p);
        uint8_t first[MAX_MESSAGE], second[MAX_MESSAGE];
        uint32_t counter = phone_iv_counter(&p);
        size_t first_len = phone_seal(&p, IDENTIFY, sizeof IDENTIFY, first);
        phone_iv_set(&p, counter + 2);
        size_t second_len = phone_seal(&p, provision, provision_len, second);
        if (!board_write(&bd, &s->script, "hsn-setup", second, second_len)->refused) {
            fail("a request out of order was accepted");
        }
        st = board_write(&bd, &s->script, "hsn-setup", first, first_len);
        if (st->refused) {
            fail("the first request was refused");
        }
        st = board_write(&bd, &s->script, "hsn-setup", second, second_len);
        if (st->refused) {
            fail("the second request, now in order, was refused");
        }
        close_session(&bd, c);
    }
}

static void write_script_file(const char *dir)
{
    json_t j;
    open_out(dir, "pairing-board-script.json", &j);
    j_open(&j, '{');
    j_key(&j, "schemaVersion");
    j_num(&j, 1);
    kv_str(&j, "description",
           "What a board running ESP-IDF's protocomm with security 2 does with each write, in "
           "order, on one connection: a script for a scripted board and a check for the real one. "
           "Each step is one write to an endpoint's characteristic (request) and what a read of it "
           "then returns (answer), or null when protocomm refused the write: protocomm_nimble.c "
           "then answers the write with ATT error 0x04 and keeps the characteristic's earlier "
           "answer, so a read after a refused write returns a stale answer and must not be made. "
           "event is the protocomm security event the board posted (credentialsMismatch is how "
           "a board counts wrong codes), boardLog the first error ESP-IDF logged, and "
           "setupHandlerRan whether the hsn-setup handler was called. srpCase names the board's "
           "salt and verifier in pairing-srp.json, and the code; a script with wrongPassword runs "
           "its first attempt with that password. boardDraws are the random values the board "
           "drew, in order: b (32 bytes) for each command 0 that reaches esp_srp (so not one "
           "refused for its length, its user name or its version), the session id (8 bytes) for "
           "each command 1 it accepts. clientPrivates are the phone's a, in order, for each "
           "command 0 made from one (A = 0 and A = N are made without).");
    kv_str(&j, "source", source);
    j_key(&j, "cases");
    j_open(&j, '[');
    for (int i = 0; i < script_count; i++) {
        board_script_t *s = &scripts[i];
        j_open(&j, '{');
        kv_str(&j, "name", s->name);
        kv_str(&j, "srpCase", s->srp_case);
        j_key(&j, "wrongPassword");
        if (s->wrong_password) {
            j_str(&j, s->wrong_password);
        } else {
            j_null(&j);
        }
        j_key(&j, "boardDraws");
        j_open(&j, '[');
        for (int d = 0; d < s->draw_count; d++) {
            j_hex(&j, s->draws[d].bytes, s->draws[d].len);
        }
        j_close(&j, ']');
        j_key(&j, "clientPrivates");
        j_open(&j, '[');
        for (int d = 0; d < s->private_count; d++) {
            j_hex(&j, s->privates[d].bytes, s->privates[d].len);
        }
        j_close(&j, ']');
        write_steps(&j, &s->script);
        j_close(&j, '}');
    }
    j_close(&j, ']');
    j_close(&j, '}');
    close_out(&j);
}

/* ----- The counter's edges ----- */

typedef struct {
    const char *name;
    uint32_t start;
    script_t script;
    sealed_t sealed[6];
    uint32_t counters[6];
    bool refused[6];
    int count;
} counter_case_t;

static void counter_cases(const char *dir, srp_case_t *c)
{
    counter_case_t cc[2];
    memset(cc, 0, sizeof cc);
    cc[0].name = "from 0xfffffffd: a request at fffffffd and its answer at fffffffe; the next "
                 "request, at ffffffff, is opened and acted on by the board, which then cannot seal "
                 "its answer and refuses the write";
    cc[0].start = 0xfffffffdu;
    cc[1].name = "from 0xfffffffe: a request at fffffffe and its answer at ffffffff; the counter "
                 "is then 0, and a request sealed at 0 is refused before it is opened";
    cc[1].start = 0xfffffffeu;
    uint8_t key[32];
    for (int k = 0; k < 2; k++) {
        board_t bd;
        phone_aead_t p;
        board_script_t scratch;
        memset(&scratch, 0, sizeof scratch);
        open_session(&bd, c, &scratch, &p);
        memcpy(key, p.key_bytes, 32);
        board_iv(&bd)->counter = htobe32(cc[k].start);
        phone_iv_set(&p, cc[k].start);
        for (int m = 0; m < 2; m++) {
            sealed_t *up = &cc[k].sealed[cc[k].count];
            cc[k].counters[cc[k].count] = phone_iv_counter(&p);
            up->direction = "toBoard";
            memcpy(up->nonce, p.iv, 12);
            memcpy(up->plaintext, IDENTIFY, sizeof IDENTIFY);
            up->plaintext_len = sizeof IDENTIFY;
            up->sealed_len = phone_seal(&p, IDENTIFY, sizeof IDENTIFY, up->sealed);
            int acted = bd.acted;
            step_t *st = board_write(&bd, &cc[k].script, "hsn-setup", up->sealed, up->sealed_len);
            cc[k].refused[cc[k].count] = st->refused;
            cc[k].count++;
            if (st->refused) {
                if (k == 0 && bd.acted == acted) {
                    fail("the board did not act on the request at ffffffff");
                }
                if (k == 1 && bd.acted != acted) {
                    fail("the board acted on a request at counter 0");
                }
                break;
            }
            sealed_t *down = &cc[k].sealed[cc[k].count];
            cc[k].counters[cc[k].count] = phone_iv_counter(&p);
            down->direction = "toPhone";
            memcpy(down->nonce, p.iv, 12);
            memcpy(down->sealed, st->answer, st->answer_len);
            down->sealed_len = st->answer_len;
            down->plaintext_len = phone_open(&p, st->answer, st->answer_len, down->plaintext);
            cc[k].count++;
        }
        if (be32toh(board_iv(&bd)->counter) != 0) {
            fail("the board's counter did not end at 0");
        }
        close_session(&bd, c);
    }

    json_t j;
    open_out(dir, "pairing-security2-counter.json", &j);
    j_open(&j, '{');
    j_key(&j, "schemaVersion");
    j_num(&j, 1);
    kv_str(&j, "description",
           "The session counter at its top, as ESP-IDF's security2.c handles it, after the "
           "handshake of srpCase (key is the first 32 bytes of its session key; sessionId the "
           "board's 8 bytes from response 1's nonce). The harness sets the board's counter to "
           "startCounter (security2.c's own session state; it takes 4 billion messages to get "
           "there otherwise) and the phone's to the same. Each message gives its counter, nonce, "
           "plaintext and sealed bytes; refused means the board refused that write. security2.c "
           "steps the counter after every message, wrapping from 0xffffffff to 0, and refuses to "
           "open or seal at 0; a request at 0xffffffff is opened and acted on but its answer "
           "cannot be sealed. So a phone seals no request at 0xffffffff, and the last answer it "
           "can receive is at 0xffffffff.");
    kv_str(&j, "source", source);
    kv_str(&j, "srpCase", c->name);
    kv_hex(&j, "key", key, sizeof key);
    kv_hex(&j, "sessionId", c->nonce, 8);
    j_key(&j, "cases");
    j_open(&j, '[');
    for (int k = 0; k < 2; k++) {
        j_open(&j, '{');
        kv_str(&j, "name", cc[k].name);
        j_key(&j, "startCounter");
        j_num(&j, cc[k].start);
        j_key(&j, "messages");
        j_open(&j, '[');
        for (int m = 0; m < cc[k].count; m++) {
            sealed_t *s = &cc[k].sealed[m];
            j_open(&j, '{');
            kv_str(&j, "direction", s->direction);
            j_key(&j, "counter");
            j_num(&j, cc[k].counters[m]);
            kv_hex(&j, "nonce", s->nonce, 12);
            kv_hex(&j, "plaintext", s->plaintext, s->plaintext_len);
            kv_hex(&j, "sealed", s->sealed, s->sealed_len);
            j_key(&j, "refused");
            j_bool(&j, cc[k].refused[m]);
            j_close(&j, '}');
        }
        j_close(&j, ']');
        j_close(&j, '}');
    }
    j_close(&j, ']');
    j_close(&j, '}');
    close_out(&j);
}

int main(int argc, char **argv)
{
    if (argc != 6) {
        fprintf(stderr, "usage: harness <dir> <idf version> <idf commit> <mbedtls commit> "
                        "<protobuf-c commit>\n");
        return 2;
    }
    if (psa_crypto_init() != PSA_SUCCESS) {
        fail("psa_crypto_init");
    }
    snprintf(source, sizeof source,
             "ESP-IDF %s (commit %s): components/protocomm/src/security/security2.c, "
             "src/common/protocomm.c, src/crypto/srp6a/esp_srp.c and esp_srp_mpi.c, proto-c/*.pb-c.c; "
             "protobuf-c 1.4.1 (commit %s); Mbed TLS 4.1.1 with TF-PSA-Crypto (commit %s). Compiled "
             "for the host and run by packages/protocol/src/pairing/esp-idf/make-vectors.sh",
             argv[2], argv[3], argv[5], argv[4]);
    unhex(provision, &provision_len, PROVISION_HEX);
    const char *dir = argv[1];

    /* SRP cases. Roles: 1 sensor, 2 siren, 3 gateway (§6). */
    srp_case_t *siren = new_case("a siren's code", "srp/siren", "hsn", "WPYX9D3F", 2);
    run_case(siren, 'x', long_all);
    srp_case_t *sensor = new_case("a sensor's code", "srp/sensor", "hsn", "A5SEPE4W", 1);
    run_case(sensor, 'x', long_all);
    srp_case_t *sb = new_case("B with a leading zero byte, sent as 383 bytes", "srp/short-b", "hsn",
                              "GW4NN3KY", 3);
    run_case(sb, 'b', short_b);
    srp_case_t *ss = new_case("S with a leading zero byte, so K hashes 383 bytes", "srp/short-s",
                              "hsn", "Q4K08R48", 1);
    run_case(ss, 'b', short_s);
    srp_case_t *sa = new_case("A with a leading zero byte, still sent as 384", "srp/short-a", "hsn",
                              "MWNRXMYG", 2);
    run_case(sa, 'a', short_a);
    srp_case_t *sv = new_case("a verifier of 383 bytes", "srp/short-v", "hsn", "92P4WZJ3", 1);
    run_case(sv, 's', short_v);
    srp_case_t *pub = new_case(
        "ESP-IDF's own published salt and verifier (test_apps/main/test_srp.c: wifiprov, abcd1234)",
        "srp/published", "wifiprov", "abcd1234", 2);
    pub->published = true;
    run_case(pub, 0, NULL);
    write_srp_file(dir);

    /* Whole exchanges. */
    session_case_t sessions[4];
    memset(sessions, 0, sizeof sessions);
    sessions[0].name = "a siren: Identify, then Provision, accepted";
    whole_pairing(siren, &sessions[0], true);
    sessions[1].name = "a sensor: Identify, then Provision, accepted";
    whole_pairing(sensor, &sessions[1], true);
    sessions[2].name = "a gateway through a short B: Identify";
    whole_pairing(sb, &sessions[2], false);
    sessions[3].name = "a short S: Identify";
    whole_pairing(ss, &sessions[3], false);
    write_security2_file(dir, sessions, 4);

    refusal_scripts(siren, "X42SA94W");
    record_draws = record_privates = NULL;
    write_script_file(dir);

    counter_cases(dir, siren);
    fprintf(stderr, "harness: wrote 4 pairing vector files to %s\n", dir);
    return 0;
}

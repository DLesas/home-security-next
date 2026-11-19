/*
 * The phone's side of SRP6a, written for the vector harness over Mbed TLS's bignum, compiled in
 * one unit with ESP-IDF's own esp_srp.c so that it reads that file's N and g rather than a copy.
 * It is a second, independent client: ESP-IDF's server code checks every proof it makes, so a
 * mistake here is a refused exchange in the harness, not a wrong vector.
 *
 *   k   = H(N | PAD(g))                 x   = H(s | H(I ":" P))
 *   A   = g^a mod N, sent as 384 bytes  u   = H(PAD(A) | PAD(B))
 *   S   = (B - k g^x)^(a + u x) mod N   K   = H(S), S without leading zero bytes
 *   M1  = H(H(N) xor H(PAD(g)) | H(I) | s | A | B | K), with A and B as sent
 *   AMK = H(A | M1 | K)
 *
 * H is SHA-512. This is what esp_srp.c computes on the board's side; nothing here is ESP-IDF's
 * code except esp_srp.c itself, included below unchanged.
 */
#define MBEDTLS_DECLARE_PRIVATE_IDENTIFIERS
#include <stdarg.h>

#include "esp_srp.c"

#include "client.h"

static void sha512_parts(uint8_t out[64], int count, ...)
{
    va_list args;
    psa_hash_operation_t op = PSA_HASH_OPERATION_INIT;
    size_t len = 0;
    psa_hash_setup(&op, PSA_ALG_SHA_512);
    va_start(args, count);
    for (int i = 0; i < count; i++) {
        const uint8_t *part = va_arg(args, const uint8_t *);
        size_t part_len = va_arg(args, size_t);
        psa_hash_update(&op, part, part_len);
    }
    va_end(args);
    psa_hash_finish(&op, out, 64, &len);
}

const uint8_t *client_group_n(void)
{
    return (const uint8_t *)N_3072;
}

int client_start(client_t *c, const uint8_t a[32])
{
    mbedtls_mpi n, g, x;
    mbedtls_mpi_init(&n);
    mbedtls_mpi_init(&g);
    mbedtls_mpi_init(&x);
    memcpy(c->a, a, 32);
    mbedtls_mpi_read_binary(&n, (const unsigned char *)N_3072, sizeof(N_3072));
    mbedtls_mpi_read_binary(&g, (const unsigned char *)g_3072, sizeof(g_3072));
    mbedtls_mpi_read_binary(&x, a, 32);
    mbedtls_mpi A;
    mbedtls_mpi_init(&A);
    int rc = mbedtls_mpi_exp_mod(&A, &g, &x, &n, NULL);
    if (rc == 0) {
        rc = mbedtls_mpi_write_binary(&A, c->A, CLIENT_KEY_LEN);
    }
    mbedtls_mpi_free(&A);
    mbedtls_mpi_free(&n);
    mbedtls_mpi_free(&g);
    mbedtls_mpi_free(&x);
    return rc;
}

int client_proof(client_t *c, const char *user, const char *pass, const uint8_t *salt,
                 size_t salt_len, const uint8_t *B, size_t B_len)
{
    uint8_t pad_g[CLIENT_KEY_LEN] = {0};
    uint8_t pad_B[CLIENT_KEY_LEN] = {0};
    uint8_t digest[64], hn[64], hg[64], hi[64], hxor[64], k_hash[64], x_hash[64];
    if (B_len > CLIENT_KEY_LEN) {
        return -1;
    }
    pad_g[CLIENT_KEY_LEN - 1] = (uint8_t)g_3072[0];
    memcpy(pad_B + CLIENT_KEY_LEN - B_len, B, B_len);

    sha512_parts(k_hash, 2, N_3072, sizeof(N_3072), pad_g, sizeof(pad_g));
    sha512_parts(digest, 3, user, strlen(user), ":", (size_t)1, pass, strlen(pass));
    sha512_parts(x_hash, 2, salt, salt_len, digest, sizeof(digest));
    sha512_parts(c->u, 2, c->A, sizeof(c->A), pad_B, sizeof(pad_B));

    mbedtls_mpi n, g, k, x, u, a, b, gx, kgx, base, e, ux, s;
    mbedtls_mpi *all[] = {&n, &g, &k, &x, &u, &a, &b, &gx, &kgx, &base, &e, &ux, &s};
    for (size_t i = 0; i < sizeof(all) / sizeof(all[0]); i++) {
        mbedtls_mpi_init(all[i]);
    }
    int rc = 0;
    rc |= mbedtls_mpi_read_binary(&n, (const unsigned char *)N_3072, sizeof(N_3072));
    rc |= mbedtls_mpi_read_binary(&g, (const unsigned char *)g_3072, sizeof(g_3072));
    rc |= mbedtls_mpi_read_binary(&k, k_hash, sizeof(k_hash));
    rc |= mbedtls_mpi_read_binary(&x, x_hash, sizeof(x_hash));
    rc |= mbedtls_mpi_read_binary(&u, c->u, sizeof(c->u));
    rc |= mbedtls_mpi_read_binary(&a, c->a, sizeof(c->a));
    rc |= mbedtls_mpi_read_binary(&b, B, B_len);
    /* base = (B - k g^x) mod N */
    rc |= mbedtls_mpi_exp_mod(&gx, &g, &x, &n, NULL);
    rc |= mbedtls_mpi_mul_mpi(&kgx, &k, &gx);
    rc |= mbedtls_mpi_mod_mpi(&kgx, &kgx, &n);
    rc |= mbedtls_mpi_sub_mpi(&base, &b, &kgx);
    rc |= mbedtls_mpi_mod_mpi(&base, &base, &n);
    /* e = a + u x */
    rc |= mbedtls_mpi_mul_mpi(&ux, &u, &x);
    rc |= mbedtls_mpi_add_mpi(&e, &a, &ux);
    rc |= mbedtls_mpi_exp_mod(&s, &base, &e, &n, NULL);
    size_t s_len = mbedtls_mpi_size(&s);
    uint8_t s_bytes[CLIENT_KEY_LEN];
    rc |= mbedtls_mpi_write_binary(&s, s_bytes, s_len);
    c->s_len = s_len;
    for (size_t i = 0; i < sizeof(all) / sizeof(all[0]); i++) {
        mbedtls_mpi_free(all[i]);
    }
    if (rc != 0) {
        return -1;
    }
    sha512_parts(c->K, 1, s_bytes, s_len);
    memset(s_bytes, 0, sizeof(s_bytes));

    sha512_parts(hn, 1, N_3072, sizeof(N_3072));
    sha512_parts(hg, 1, pad_g, sizeof(pad_g));
    for (int i = 0; i < 64; i++) {
        hxor[i] = hn[i] ^ hg[i];
    }
    sha512_parts(hi, 1, user, strlen(user));
    sha512_parts(c->M1, 6, hxor, sizeof(hxor), hi, sizeof(hi), salt, salt_len, c->A, sizeof(c->A),
                 B, B_len, c->K, sizeof(c->K));
    sha512_parts(c->AMK, 3, c->A, sizeof(c->A), c->M1, sizeof(c->M1), c->K, sizeof(c->K));
    return 0;
}

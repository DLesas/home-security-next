/* The harness's own SRP6a client (client.c), checked by ESP-IDF's server code. */
#pragma once
#include <stddef.h>
#include <stdint.h>

#define CLIENT_KEY_LEN 384

typedef struct {
    uint8_t a[32];
    /* A, padded to the group's 384 bytes, as security 2 requires it sent. */
    uint8_t A[CLIENT_KEY_LEN];
    uint8_t u[64];
    uint8_t K[64];
    size_t s_len;
    uint8_t M1[64];
    uint8_t AMK[64];
} client_t;

const uint8_t *client_group_n(void);
int client_start(client_t *c, const uint8_t a[32]);
int client_proof(client_t *c, const char *user, const char *pass, const uint8_t *salt,
                 size_t salt_len, const uint8_t *B, size_t B_len);

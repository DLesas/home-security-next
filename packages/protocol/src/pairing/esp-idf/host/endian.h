/* Host stand-in for newlib's endian.h, which security2.c includes for the nonce's counter. */
#pragma once
#include <libkern/OSByteOrder.h>
#define htobe32(x) OSSwapHostToBigInt32(x)
#define be32toh(x) OSSwapBigToHostInt32(x)

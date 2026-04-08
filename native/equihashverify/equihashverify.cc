#include <nan.h>

// equi.h is C code; ensure the symbol linkage for verifyEH is unmangled when
// compiled as C++ (Node addon).
extern "C" {
#include "src/equi/equi.h"
}

// Zcash Equihash parameters (n=200,k=9)
// Header without solution is 140 bytes (incl. nonce).
static constexpr size_t ZCASH_HEADER_LEN = 140;
static constexpr size_t ZCASH_SOLUTION_LEN = 1344;
// CompactSize prefix for 1344 is: 0xFD 0x40 0x05 (little-endian 0x0540)
static constexpr unsigned char ZCASH_SOLUTION_PREFIX[3] = {0xFD, 0x40, 0x05};

static void Verify(const Nan::FunctionCallbackInfo<v8::Value> &info) {
  if (info.Length() != 2) {
    return Nan::ThrowTypeError("Wrong number of arguments (expected headerBuf, solutionBuf)");
  }
  if (!node::Buffer::HasInstance(info[0]) || !node::Buffer::HasInstance(info[1])) {
    return Nan::ThrowTypeError("Arguments should be Buffer objects");
  }

  v8::Local<v8::Object> headerObj = info[0].As<v8::Object>();
  v8::Local<v8::Object> solObj = info[1].As<v8::Object>();

  const unsigned char *header = reinterpret_cast<const unsigned char *>(node::Buffer::Data(headerObj));
  const size_t headerLen = node::Buffer::Length(headerObj);

  const unsigned char *sol = reinterpret_cast<const unsigned char *>(node::Buffer::Data(solObj));
  const size_t solLen = node::Buffer::Length(solObj);

  // Header must be exactly 140 bytes for Zcash.
  if (headerLen != ZCASH_HEADER_LEN) {
    return Nan::ThrowRangeError("Invalid header length (expected 140 bytes)");
  }

  // Miners often submit the Equihash solution with a CompactSize length prefix.
  // The Zcash block header stores nSolution as CompactSize + raw solution bytes.
  // Our verifier expects ONLY the raw 1344-byte solution.
  const unsigned char *solRaw = sol;
  size_t solRawLen = solLen;

  if (solLen == (ZCASH_SOLUTION_LEN + 3) &&
      sol[0] == ZCASH_SOLUTION_PREFIX[0] && sol[1] == ZCASH_SOLUTION_PREFIX[1] && sol[2] == ZCASH_SOLUTION_PREFIX[2]) {
    solRaw = sol + 3;
    solRawLen = solLen - 3;
  }

  if (solRawLen != ZCASH_SOLUTION_LEN) {
    return Nan::ThrowRangeError("Invalid solution length (expected 1344 bytes or 1347 with CompactSize prefix)");
  }

  const bool ok = verifyEH(reinterpret_cast<const char *>(header), reinterpret_cast<const char *>(solRaw));
  info.GetReturnValue().Set(Nan::New(ok));
}

static void Init(v8::Local<v8::Object> exports) {
  Nan::Set(exports, Nan::New("verify").ToLocalChecked(),
           Nan::GetFunction(Nan::New<v8::FunctionTemplate>(Verify)).ToLocalChecked());
}

NODE_MODULE(equihashverify, Init)

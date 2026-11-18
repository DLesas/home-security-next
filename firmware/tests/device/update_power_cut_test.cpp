// A power cut at every flash operation of a whole update (m3-updates-design.md section 6, "Every
// stage, and a power cut or reset there", and section 8): for each erase, write and read of the
// other slot, each record write and erase, and each otadata write (select, confirm) with either
// copy winning, the power fails there; the board starts again, runs an image that works, and then
// finishes the update, resuming from its checkpoint or starting again as the table says.

#include <algorithm>
#include <map>
#include <set>
#include <string>

#include "update_bench.hpp"

namespace hsn::test::update {
namespace {

using device::UpdatePacketKind;
using device::UpdatePath;
using protocol::UpdateAction;
using protocol::UpdateStage;

constexpr std::uint32_t kHeader = 128;
const protocol::FirmwareVersion kOld{1, 0, 0};
const protocol::FirmwareVersion kNew{1, 1, 0};
constexpr std::size_t kImageSize = 70000;  // 18 sectors: one checkpoint, at 64 KB

bool same(const protocol::FirmwareVersion& a, const protocol::FirmwareVersion& b) {
  return a.major == b.major && a.minor == b.minor && a.patch == b.patch;
}

std::uint32_t record_bytes(const Bytes& record) {
  return static_cast<std::uint32_t>(record[130] | (record[131] << 8) | (record[132] << 16) |
                                    (record[133] << 24));
}

/**
 * The hub and the role around one update: the hub offers the image, answers each query (install
 * a verified image, otherwise fetch), says "install now" once verified, and offers again after a
 * refusal or when the device has nothing to say; the role reports health once a trial image runs.
 */
class Rollout {
public:
  Rollout(Bench& bench, const ImageFile& file)
      : source(bench, LinkKind::network, file.file()), bench_(bench), file_(file) {}

  void offer(std::uint8_t action) {
    offers += 1;
    bench_.update().offer(make_offer(action, file_), UpdatePath::network, bench_.now);
  }

  /** True once the new image runs confirmed and nothing of the update is left. */
  bool finished() const {
    const device::UpdateService& update = bench_.instance->services.update;
    return same(update.running().version, kNew) && !update.on_trial() &&
           !bench_.storage.has(device::StoreKey::update) &&
           !bench_.instance->device.next_wake().restart;
  }

  /**
   * Drives the update through restarts until it is finished; false when the power fails first.
   */
  bool drive() {
    for (int round = 0; round < 40; ++round) {
      if (finished()) {
        return true;
      }
      const bool settled = run(
          bench_, source, [&] { return finished(); },
          [&](const device::UpdatePacket& packet) { answer(packet); });
      if (!bench_.power.on) {
        return false;
      }
      if (settled) {
        return true;
      }
      if (bench_.instance->device.next_wake().restart) {
        bench_.boot(device::BootKind::other_reset);
        boots += 1;
        if (bench_.update().on_trial()) {
          // The role's health condition: for a sensor, the reply to its Started.
          bench_.update().healthy(bench_.now);
        }
        continue;
      }
      // Nothing more to do and nothing said: the rollout offers the image again.
      offer(UpdateAction::fetch);
    }
    FAIL("the update did not finish");
    return false;
  }

  Source source;
  Packets packets;
  int offers = 0;
  int boots = 0;

private:
  void answer(const device::UpdatePacket& packet) {
    packets.push_back(packet);
    if (packet.kind == UpdatePacketKind::query) {
      const bool verified =
          packet.query.held == protocol::UpdateHeld::verified && packet.query.image_id == file_.id;
      offer(verified ? UpdateAction::install_now : UpdateAction::fetch);
      return;
    }
    if (packet.status.stage == UpdateStage::verified) {
      offer(UpdateAction::install_now);
    } else if (packet.status.stage == UpdateStage::refused) {
      offer(UpdateAction::fetch);
    }
  }

  Bench& bench_;
  const ImageFile& file_;
};

/** A whole update on a fresh board, with the power cut after `ops` operations (or never). */
struct Run {
  explicit Run(const ImageFile& file, std::optional<std::size_t> ops = std::nullopt,
               bool otadata_lands = false)
      : rollout(bench, file) {
    bench.slots.otadata_lands = otadata_lands;
    bench.boot();
    base = bench.power.ops.size();
    if (ops.has_value()) {
      bench.power.budget = base + *ops;
    }
    rollout.offer(UpdateAction::fetch);
  }

  Bench bench;
  Rollout rollout;
  std::size_t base = 0;
};

/** Which row of section 6's table a cut falls in. */
std::string row_of(const FlashOp& op, bool verified_held, bool selected, bool lands) {
  switch (op.kind) {
    case FlashOp::Kind::slot_erase:
    case FlashOp::Kind::slot_write:
      return "erasing or writing the other slot";
    case FlashOp::Kind::slot_read:
      return verified_held ? "verified, reading back before select" : "reading back and hashing";
    case FlashOp::Kind::select:
      return lands ? "select(): the new otadata copy wins" : "select(): the old copy wins";
    case FlashOp::Kind::confirm:
      return lands ? "confirm(): the new copy wins" : "confirm(): the old copy wins";
    case FlashOp::Kind::reject:
      return "reject()";
    case FlashOp::Kind::record_write:
      if (op.key != device::StoreKey::update) {
        return selected ? "another record, after select" : "another record";
      }
      return "writing the checkpoint record";
    case FlashOp::Kind::record_erase:
      return "erasing the record once confirmed";
  }
  return "?";
}

TEST_CASE("section 6: a power cut at every flash operation of an update, then it finishes") {
  const ImageFile file = make_file(make_image(kNew, kImageSize));

  // The operations of an update without a cut, in order.
  std::vector<FlashOp> clean;
  {
    Run r(file);
    REQUIRE(r.rollout.drive());
    clean.assign(r.bench.power.ops.begin() + static_cast<std::ptrdiff_t>(r.base),
                 r.bench.power.ops.end());
    REQUIRE(r.bench.slots.running_works());
    CHECK(r.rollout.boots == 1);
  }
  std::set<FlashOp::Kind> kinds;
  for (const FlashOp& op : clean) {
    kinds.insert(op.kind);
  }
  // Everything the design lists is in it: about a hundred runs below.
  CHECK(kinds.count(FlashOp::Kind::slot_erase) == 1);
  CHECK(kinds.count(FlashOp::Kind::slot_write) == 1);
  CHECK(kinds.count(FlashOp::Kind::slot_read) == 1);
  CHECK(kinds.count(FlashOp::Kind::record_write) == 1);
  CHECK(kinds.count(FlashOp::Kind::select) == 1);
  CHECK(kinds.count(FlashOp::Kind::confirm) == 1);
  CHECK(kinds.count(FlashOp::Kind::record_erase) == 1);
  REQUIRE(clean.size() > 70);

  std::map<std::string, int> rows;
  std::size_t runs = 0;
  for (std::size_t n = 0; n < clean.size(); ++n) {
    const bool otadata =
        clean[n].kind == FlashOp::Kind::select || clean[n].kind == FlashOp::Kind::confirm;
    for (const bool lands : {false, true}) {
      if (lands && !otadata) {
        continue;
      }
      CAPTURE(n);
      CAPTURE(lands);
      Run r(file, n, lands);
      runs += 1;
      REQUIRE_FALSE(r.rollout.drive());
      REQUIRE(r.bench.power.cut_in.has_value());
      const FlashOp cut = *r.bench.power.cut_in;
      CHECK(cut.kind == clean[n].kind);
      CHECK(cut.offset == clean[n].offset);
      const std::string cut_name = name_of(cut.kind);
      CAPTURE(cut_name);

      const bool record_before = r.bench.storage.has(device::StoreKey::update);
      const Bytes record =
          record_before ? r.bench.storage.records[device::StoreKey::update] : Bytes();
      const bool verified_held = record_before && record[129] == 2;
      const bool selected = r.bench.slots.select_calls > 0;
      const std::string row = row_of(cut, verified_held, selected, lands);
      rows[row] += 1;
      CAPTURE(row);

      // The power comes back: the bootloader runs something that works.
      r.bench.power.restore();
      r.bench.boot(device::BootKind::power_on);
      REQUIRE(r.bench.slots.running_works());
      const device::BootImage image = r.bench.update().running();
      const bool new_running = same(image.version, kNew);
      CHECK((new_running || same(image.version, kOld)));

      if (!selected || (cut.kind == FlashOp::Kind::select && !lands)) {
        // Before select() took effect: the old image, confirmed, untouched by the update.
        CHECK(same(image.version, kOld));
        CHECK_FALSE(image.on_trial);
        CHECK_FALSE(image.rolled_back);
        // The record is as the last whole write left it.
        CHECK(r.bench.storage.has(device::StoreKey::update) == record_before);
        if (record_before) {
          CHECK(r.bench.storage.records[device::StoreKey::update] == record);
          // The next query reports it.
          const auto query = r.bench.update().next_packet(r.bench.now);
          REQUIRE(query.kind == UpdatePacketKind::query);
          CHECK(query.query.image_id == file.id);
          CHECK(query.query.bytes_held == record_bytes(record));
          CHECK(query.query.held ==
                (verified_held ? protocol::UpdateHeld::verified : protocol::UpdateHeld::part));
        }
      } else if (cut.kind == FlashOp::Kind::select ||
                 (selected && r.bench.slots.confirm_calls == 0)) {
        // select() took effect, then the power went before the new image confirmed: it boots
        // on trial, or (a cut on its first boot) has already been rolled back.
        CHECK(((new_running && image.on_trial) || (!new_running && image.rolled_back)));
      } else if (cut.kind == FlashOp::Kind::confirm && !lands) {
        // Still on trial at the cut: rolled back, and the old image says so.
        CHECK_FALSE(new_running);
        CHECK(image.rolled_back);
        CHECK(same(image.failed, kNew));
        CHECK_FALSE(r.bench.storage.has(device::StoreKey::update));
      } else {
        // Confirmed (otadata landed); a record left behind is cleared at this boot.
        CHECK(new_running);
        CHECK_FALSE(image.on_trial);
        CHECK_FALSE(r.bench.storage.has(device::StoreKey::update));
        CHECK_FALSE(r.bench.update().next_packet(r.bench.now).kind != UpdatePacketKind::none);
      }

      // Then the update finishes.
      const std::size_t gets_before = r.rollout.source.gets.size();
      const std::uint32_t hashes_before = r.bench.crypto.sha_starts;
      if (!r.bench.update().on_trial() &&
          r.bench.update().next_packet(r.bench.now).kind == UpdatePacketKind::none &&
          !new_running) {
        r.rollout.offer(UpdateAction::fetch);  // "the offer comes again"
      }
      if (r.bench.update().on_trial()) {
        r.bench.update().healthy(r.bench.now);
      }
      REQUIRE(r.rollout.drive());
      CHECK(same(r.bench.update().running().version, kNew));
      CHECK_FALSE(r.bench.update().on_trial());
      REQUIRE(r.bench.slots.running_works());
      const Bytes& running =
          r.bench.slots.bytes[static_cast<std::size_t>(r.bench.slots.running_slot())];
      CHECK(Bytes(running.begin(), running.begin() + static_cast<std::ptrdiff_t>(kImageSize)) ==
            file.image);

      // Where the pull resumed: at the checkpoint the record held, with no header again; from
      // the header when there was none; nothing pulled when the image was verified.
      const auto& gets = r.rollout.source.gets;
      if (!selected && record_before && !verified_held) {
        REQUIRE(gets.size() > gets_before);
        CHECK(gets[gets_before].offset == record_bytes(record));
        CHECK(gets[gets_before].offset >= kHeader);
      } else if (!selected && !record_before) {
        REQUIRE(gets.size() > gets_before);
        CHECK(gets[gets_before].offset == 0);
      } else if (verified_held && !selected) {
        CHECK(gets.size() == gets_before);
        // The hash is computed again before select.
        CHECK(r.bench.crypto.sha_starts > hashes_before);
      }
    }
  }
  CAPTURE(runs);
  CHECK(runs > clean.size());
  for (const char* expected : {"erasing or writing the other slot", "writing the checkpoint record",
                               "reading back and hashing", "verified, reading back before select",
                               "select(): the old copy wins", "select(): the new otadata copy wins",
                               "confirm(): the old copy wins", "confirm(): the new copy wins",
                               "erasing the record once confirmed"}) {
    CAPTURE(expected);
    CHECK(rows[expected] > 0);
  }
}

TEST_CASE("section 6: a reset after the header's check, before anything is written") {
  Bench bench;
  bench.boot();
  const ImageFile file = make_file(make_image(kNew, kImageSize));
  Source hub(bench, LinkKind::network, file.file());
  hub.rules.ignore_always = true;
  bench.update().offer(make_offer(UpdateAction::fetch, file), UpdatePath::network, bench.now);
  hub.serve();
  const Bytes served = file.file();
  // The header arrives and passes; the reset comes before the record is written.
  bench.power.budget = bench.power.ops.size();
  bench.deliver_link(LinkKind::network, device::LinkEventKind::packet,
                     data_frame(file.id, served, 0, 128));
  REQUIRE_FALSE(bench.power.on);
  CHECK(bench.crypto.verifies == 1);
  bench.power.restore();
  bench.boot();
  CHECK(same(bench.update().running().version, kOld));
  CHECK_FALSE(bench.storage.has(device::StoreKey::update));
  CHECK_FALSE(bench.take_packet().has_value());
  CHECK(bench.slots.states[1] == TestSlots::State::empty);
}

TEST_CASE("section 6: a reset while reading back computes the hash again from the checkpoint") {
  const ImageFile file = make_file(make_image(kNew, kImageSize));
  Run r(file);
  // Stop at the first read of the hash.
  REQUIRE(run(r.bench, r.rollout.source, [&] {
    return std::any_of(r.bench.power.ops.begin(), r.bench.power.ops.end(),
                       [](const FlashOp& op) { return op.kind == FlashOp::Kind::slot_read; });
  }));
  const std::uint32_t hashes = r.bench.crypto.sha_starts;
  r.bench.boot(device::BootKind::other_reset);
  // The record still holds the checkpoint at 64 KB: the last two sectors come again, then the
  // whole hash.
  const auto query = r.bench.update().next_packet(r.bench.now);
  CHECK(query.query.bytes_held == kHeader + 65536);
  REQUIRE(r.rollout.drive());
  CHECK(r.bench.crypto.sha_starts > hashes + 1);
}

}  // namespace
}  // namespace hsn::test::update

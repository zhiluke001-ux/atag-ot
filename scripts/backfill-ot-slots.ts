import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  const events = await prisma.otEvent.findMany({
    include: { assignments: true, slots: true },
  });

  for (const ev of events) {
    // if already has slots, just attach missing assignment.otSlotId to the first slot
    if (ev.slots.length > 0) {
      const first = ev.slots.sort((a, b) => a.index - b.index)[0];
      const missing = ev.assignments.filter((a) => !a.otSlotId).map((a) => a.id);
      if (missing.length) {
        await prisma.otAssignment.updateMany({
          where: { id: { in: missing } },
          data: { otSlotId: first.id },
        });
      }
      continue;
    }

    // create a single slot using event's legacy start/end/taskCodes
    const slot = await prisma.otSlot.create({
      data: {
        otEventId: ev.id,
        index: 0,
        startTime: ev.startTime,
        endTime: ev.endTime,
        taskCodes: ev.taskCodes,
      },
    });

    // attach all assignments
    if (ev.assignments.length) {
      await prisma.otAssignment.updateMany({
        where: { otEventId: ev.id },
        data: { otSlotId: slot.id },
      });
    }
  }

  console.log("Backfill completed ✅");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => prisma.$disconnect());

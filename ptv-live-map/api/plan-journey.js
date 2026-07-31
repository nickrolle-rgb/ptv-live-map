// SPIKE — validating the Node.js runtime + bundled schedule-data architecture only,
// not yet the real Phase 5 search algorithm. No `export const config = { runtime:
// 'edge' }` here (unlike every other file in api/) — Node.js is Vercel's default
// runtime when omitted, and is what this needs: Edge Functions cap their bundle at
// 2-4MB, well under the 16MB train+V/Line schedule data, while Node.js Functions allow
// up to 250MB uncompressed. Also note the handler signature differs from the Edge
// functions in this folder — Node.js functions use the classic (req, res) shape, not
// the Fetch API (Request) => Response one.
import trainSchedule from '../src/data/schedule/train-schedule.json' with { type: 'json' };
import vlineSchedule from '../src/data/schedule/vline-schedule.json' with { type: 'json' };

export default function handler(req, res) {
  res.status(200).json({
    nodeVersion: process.version,
    train: { trips: Object.keys(trainSchedule.trips).length, stops: trainSchedule.stopIds.length },
    vline: { trips: Object.keys(vlineSchedule.trips).length, stops: vlineSchedule.stopIds.length },
  });
}

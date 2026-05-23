const assert = require('assert');
const { generateSchedule } = require('../utils/scheduler');

function toMinutes(time) {
  const [hours, minutes] = time.split(':').map(Number);
  return hours * 60 + minutes;
}

const exams = [
  {
    _id: '1',
    subject: 'Math',
    difficulty: 3,
    currentKnowledge: 3,
    examDate: '2026-06-01',
    availableHours: { mon: 4, tue: 4, wed: 4, thu: 4, fri: 4 },
    syllabusTopics: [
      { name: 'Algebra', hours: 4, missedHours: 0 },
      { name: 'Geometry', hours: 4, missedHours: 0 }
    ],
    breakRatio: { study: 50, break: 10 },
    priority: 2,
    color: '#ff0000'
  },
  {
    _id: '2',
    subject: 'Physics',
    difficulty: 3,
    currentKnowledge: 3,
    examDate: '2026-06-01',
    availableHours: { mon: 4, tue: 4, wed: 4, thu: 4, fri: 4 },
    syllabusTopics: [
      { name: 'Kinematics', hours: 4, missedHours: 0 },
      { name: 'Dynamics', hours: 4, missedHours: 0 }
    ],
    breakRatio: { study: 50, break: 10 },
    priority: 2,
    color: '#00ff00'
  }
];

const config = {
  startDate: '2026-05-18',
  startHour: 11,
  endHour: 18,
  studyBlock: 50,
  breakBlock: 10
};

const result = generateSchedule(exams, config, []);
assert(Array.isArray(result.schedule), 'Expected schedule to be an array');

const daysWithSessions = result.schedule.filter(day => day.sessions && day.sessions.length > 0);
assert(daysWithSessions.length > 0, 'Expected at least one scheduled day');

for (const day of daysWithSessions) {
  const ordered = [...day.sessions].sort((a, b) => toMinutes(a.startTime) - toMinutes(b.startTime));
  const seenStarts = new Set();

  ordered.forEach((block, index) => {
    const blockStart = toMinutes(block.startTime);
    const blockEnd = blockStart + block.duration;

    assert(!seenStarts.has(block.startTime), `Duplicate start time ${block.startTime} on ${day.date}`);
    seenStarts.add(block.startTime);

    if (index > 0) {
      const prev = ordered[index - 1];
      const prevEnd = toMinutes(prev.startTime) + prev.duration;
      const currStart = toMinutes(block.startTime);

      assert(currStart >= prevEnd, `Overlap detected on ${day.date}: ${prev.type} @ ${prev.startTime} overlaps ${block.type} @ ${block.startTime}`);
      assert(block.type !== prev.type, `Invalid block sequence on ${day.date}: ${prev.type} followed by ${block.type}`);
    }
  });

  const lastBlock = ordered[ordered.length - 1];
  if (day.date < '2026-06-01') {
    assert(lastBlock.type !== 'Break', `Day should not end with a Break on ${day.date}`);
  }
}

console.log('Scheduler regression test passed.');

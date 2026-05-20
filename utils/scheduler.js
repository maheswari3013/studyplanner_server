const SPACED_INTERVALS = [1, 3, 7, 14];
const MIN_BLOCK_HOURS = 0.5;
const DAY_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const DEFAULT_BASE_HOURS_PER_TOPIC = 10;

const mapDifficulty = (val) => {
  if (val <= 2) return 'Easy';
  if (val <= 4) return 'Medium';
  return 'Hard';
};

const normalizeTopics = (exam) => {
  if (Array.isArray(exam.syllabusTopics) && exam.syllabusTopics.length > 0 && typeof exam.syllabusTopics[0] === 'object') {
    return exam.syllabusTopics.map(t => ({
      name: t.name.trim(),
      hours: t.hours > 0? t.hours : DEFAULT_BASE_HOURS_PER_TOPIC
    }));
  }
  if (exam.totalHours > 0) {
    const topicNames = exam.syllabusTopics?.length > 0
     ? exam.syllabusTopics.filter(t => typeof t === 'string' && t.trim())
      : ['General'];
    const hoursPerTopic = exam.totalHours / topicNames.length;
    return topicNames.map(name => ({ name: name.trim(), hours: hoursPerTopic }));
  }
  if (Array.isArray(exam.syllabusTopics) && exam.syllabusTopics.length > 0) {
    return exam.syllabusTopics.map(t => ({ name: t.trim(), hours: DEFAULT_BASE_HOURS_PER_TOPIC })).filter(t => t.name);
  }
  return [{ name: 'General', hours: DEFAULT_BASE_HOURS_PER_TOPIC }];
};

const toISTDateString = (date) => {
  return new Date(date).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
};

function timeToMinutes(time) {
  const [h, m] = time.split(':').map(Number);
  return h * 60 + m;
}

const isTimeOccupied = (date, startTime, duration, existingBlocks) => {
  const startMin = timeToMinutes(startTime);
  const endMin = startMin + duration;
  return existingBlocks.some(b => {
    if (b.date!== date) return false;
    const bStart = timeToMinutes(b.time);
    const bEnd = bStart + b.duration;
    return startMin < bEnd && endMin > bStart;
  });
};

function generateSchedule(exams, config, existingBlocks = []) {
  console.log('EXAM PAYLOAD:', JSON.stringify(exams[0].availableHours));
  const { startDate, startHour, endHour, studyBlock, breakBlock } = config;
  const result = { schedule: [], conflicts: [], warnings: [], metadata: {} };

  const startDateStr = startDate? toISTDateString(startDate) : toISTDateString(new Date());
  const startDateObj = new Date(startDateStr + 'T00:00:00');

  const examDates = exams.map(e => new Date(e.examDate || e.date)).filter(d =>!isNaN(d));

  // FIX: Don't subtract 1 day. Schedule up to exam date.
  const lastExamDate = examDates.length > 0? new Date(Math.max(...examDates)) : new Date(startDateObj);

  // FIX: Calculate days from start to last exam, inclusive
  const daysToSchedule = Math.max(1, Math.ceil((lastExamDate - startDateObj) / (1000 * 60 * 60 * 24)) + 1);

  const availableDaysMap = new Map();
  let currentDate = new Date(startDateObj);
  let dayCount = 0;

  console.log(`[Scheduler] Start: ${startDateStr}, End: ${toISTDateString(lastExamDate)}, Days: ${daysToSchedule}`);

  while (currentDate <= lastExamDate && dayCount < daysToSchedule) {
    const dateStr = toISTDateString(currentDate);
    const dayName = DAY_NAMES[currentDate.getDay()];
    const dayData = {
      date: dateStr,
      dateObj: new Date(currentDate),
      sessions: [],
      usedHours: 0,
      examCaps: {},
      totalAvailable: 0
    };

    exams.forEach(exam => {
      // FIX: Use exam.availableHours correctly with lowercase day names
      const examHours = exam.availableHours?.[dayName];
      console.log(`[Scheduler] ${dateStr} ${dayName}: exam ${exam.subject} has ${examHours}h`);

      if (examHours > 0) {
        const examKey = exam._id? exam._id.toString() : exam.subject;
        dayData.examCaps[examKey] = {
          available: examHours,
          used: 0,
          breakRatio: exam.breakRatio || { study: 25, break: 5 },
          subject: exam.subject,
          color: exam.color || '#3B82F6'
        };
        dayData.totalAvailable += examHours;
      }
    });

    if (dayData.totalAvailable > 0) {
      availableDaysMap.set(dateStr, dayData);
      dayCount++;
    }
    currentDate.setDate(currentDate.getDate() + 1);
  }

  console.log(`[Scheduler] Available days with hours: ${availableDaysMap.size}`);

  const availableDays = Array.from(availableDaysMap.values());

  existingBlocks.forEach(block => {
    const day = availableDaysMap.get(block.date);
    if (day) {
      const examCap = Object.values(day.examCaps).find(ec => ec.subject === block.subject);
      if (examCap) {
        examCap.used += block.duration / 60;
        day.usedHours += block.duration / 60;
      }
    }
  });

  const topics = [];
  let totalRequiredHours = 0;

  exams.forEach(exam => {
    const difficultyMultiplier = { 'Easy': 1, 'Medium': 1.3, 'Hard': 1.6 }[mapDifficulty(exam.difficulty || 3)];
    const knowledgeMultiplier = 1 + (5 - (exam.currentKnowledge || 3)) * 0.1;
    const topicsList = normalizeTopics(exam);
    const examId = exam._id? exam._id.toString() : exam.subject;
    const examDate = new Date(exam.examDate || exam.date);

    // FIX: Count days before exam, not including exam day
    const daysBeforeExam = availableDays.filter(d => new Date(d.date) < examDate && d.examCaps[examId]).length;

    // FIX: Handle empty availableHours gracefully
    const availableHoursValues = Object.values(exam.availableHours || {});
    const maxDailyHours = availableHoursValues.length > 0
     ? Math.max(...availableHoursValues)
      : (endHour - startHour);

    const maxPossibleHours = daysBeforeExam * maxDailyHours;

    console.log(`[Scheduler] Exam ${exam.subject}: daysBeforeExam=${daysBeforeExam}, maxDailyHours=${maxDailyHours}, maxPossible=${maxPossibleHours}`);

    topicsList.forEach(topic => {
      const adjustedHoursPerTopic = topic.hours * difficultyMultiplier * knowledgeMultiplier;

      console.log(`[Scheduler] Topic ${topic.name}: base=${topic.hours}h, adjusted=${adjustedHoursPerTopic.toFixed(1)}h`);

      if (adjustedHoursPerTopic > maxPossibleHours && maxPossibleHours > 0) {
        result.conflicts.push({
          type: 'TOPIC_IMPOSSIBLE',
          message: `Topic "${topic.name}" in ${exam.subject} needs ${adjustedHoursPerTopic.toFixed(1)}h but only ${maxPossibleHours.toFixed(1)}h possible.`,
          examName: exam.subject,
          topicName: topic.name,
          required: adjustedHoursPerTopic,
          maxPossible: maxPossibleHours
        });
      }
      totalRequiredHours += adjustedHoursPerTopic;
      topics.push({
        examId,
        examName: exam.subject,
        examDate: exam.examDate || exam.date,
        color: exam.color || '#3B82F6',
        topicName: topic.name,
        baseHoursPerTopic: topic.hours,
        adjustedHoursPerTopic,
        hoursRemaining: adjustedHoursPerTopic,
        difficulty: exam.difficulty || 3,
        knowledgeLevel: exam.currentKnowledge || 3,
        userPriority: exam.priority || 3,
        daysUntilExam: Math.ceil((examDate - new Date(startDateStr)) / (1000 * 60 * 60 * 24)),
        breakRatio: exam.breakRatio || { study: 25, break: 5 }
      });
    });
  });

  const totalAvailableHours = availableDays.reduce((sum, day) => sum + day.totalAvailable, 0);

  console.log(`[Scheduler] Total required: ${totalRequiredHours.toFixed(1)}h, Available: ${totalAvailableHours.toFixed(1)}h`);

  if (totalRequiredHours > totalAvailableHours) {
    const deficit = totalRequiredHours - totalAvailableHours;
    result.conflicts.push({
      type: 'INSUFFICIENT_TIME',
      message: `Need ${deficit.toFixed(1)} more hours total.`,
      required: totalRequiredHours,
      available: totalAvailableHours,
      deficit
    });
  }

  if (result.conflicts.some(c => c.type === 'TOPIC_IMPOSSIBLE')) {
    result.metadata = { totalRequiredHours, totalAvailableHours, status: 'FAILED_VALIDATION' };
    return result;
  }

  const sortedTopics = topics.filter(t => t.hoursRemaining > 0).sort((a, b) => {
    if (a.userPriority!== b.userPriority) return a.userPriority - b.userPriority;
    if (a.daysUntilExam!== b.daysUntilExam) return a.daysUntilExam - b.daysUntilExam;
    return b.hoursRemaining - a.hoursRemaining;
  });

  for (const topic of sortedTopics) {
    let hoursToSchedule = topic.hoursRemaining;
    console.log(`[Scheduler] Scheduling topic: ${topic.topicName}, hours: ${hoursToSchedule.toFixed(1)}`);

    for (const day of availableDays) {
      if (hoursToSchedule <= 0) break;
      if (new Date(day.date) >= new Date(topic.examDate)) continue;

      const examCap = day.examCaps[topic.examId];
      if (!examCap) continue;

      let examDayRemaining = examCap.available - examCap.used;
      if (examDayRemaining < MIN_BLOCK_HOURS) continue;

      const studyMinutes = studyBlock || examCap.breakRatio.study;
      const breakMinutes = breakBlock || examCap.breakRatio.break;
      const blockHours = studyMinutes / 60;
      const breakHours = breakMinutes / 60;

      let currentMinutes = startHour * 60 + day.usedHours * 60;

      while (hoursToSchedule >= MIN_BLOCK_HOURS && examDayRemaining >= MIN_BLOCK_HOURS) {
        if (currentMinutes + studyMinutes > endHour * 60) break;

        const actualStudyHours = Math.min(blockHours, hoursToSchedule, examDayRemaining);
        const actualStudyMinutes = Math.round(actualStudyHours * 60);
        if (actualStudyMinutes < MIN_BLOCK_HOURS * 60) break;

        const startTime = `${String(Math.floor(currentMinutes / 60)).padStart(2, '0')}:${String(Math.round(currentMinutes % 60)).padStart(2, '0')}`;

        if (isTimeOccupied(day.date, startTime, actualStudyMinutes, existingBlocks)) {
          currentMinutes += 10;
          continue;
        }

        day.sessions.push({
          type: 'Study',
          examId: topic.examId,
          examName: topic.examName,
          color: topic.color,
          topicName: topic.topicName,
          hours: actualStudyHours,
          priority: topic.userPriority,
          date: day.date,
          startTime,
          duration: actualStudyMinutes,
          isBreak: false,
          isGenerated: true
        });

        currentMinutes += actualStudyMinutes;
        examCap.used += actualStudyHours;
        day.usedHours += actualStudyHours;
        hoursToSchedule -= actualStudyHours;
        examDayRemaining -= actualStudyHours;

        const canAddBreak = currentMinutes + breakMinutes <= endHour * 60 && examDayRemaining > 0.01 && hoursToSchedule > 0;
        if (canAddBreak) {
          const breakStartTime = `${String(Math.floor(currentMinutes / 60)).padStart(2, '0')}:${String(Math.round(currentMinutes % 60)).padStart(2, '0')}`;
          if (!isTimeOccupied(day.date, breakStartTime, breakMinutes, existingBlocks)) {
            day.sessions.push({
              type: 'Break',
              examId: topic.examId,
              examName: topic.examName,
              color: '#10B981',
              topicName: 'Break',
              hours: breakHours,
              date: day.date,
              startTime: breakStartTime,
              duration: breakMinutes,
              isBreak: true,
              isGenerated: true
            });
            const actualBreakHours = Math.min(breakHours, examDayRemaining);
            examCap.used += actualBreakHours;
            day.usedHours += actualBreakHours;
            examDayRemaining -= actualBreakHours;
          }
          currentMinutes += breakMinutes;
        } else {
          break;
        }
      }
    }

    if (hoursToSchedule > 0.1) {
      console.log(`[Scheduler] Warning: ${topic.topicName} has ${hoursToSchedule.toFixed(1)}h unscheduled`);
      result.warnings.push({
        topic: `${topic.examName} - ${topic.topicName}`,
        message: `Could not schedule ${hoursToSchedule.toFixed(1)}h.`,
        hoursUnscheduled: hoursToSchedule
      });
    }
  }

  result.schedule = availableDays.map(day => ({
    date: day.date,
    sessions: day.sessions.sort((a, b) => a.startTime.localeCompare(b.startTime))
  }));

  const totalBlocks = result.schedule.reduce((sum, day) => sum + day.sessions.length, 0);
  console.log(`[Scheduler] Generated ${totalBlocks} blocks total`);

  result.metadata = {
    totalRequiredHours,
    totalAvailableHours,
    totalBlocksGenerated: totalBlocks,
    status: result.conflicts.length > 0? 'HAS_CONFLICTS' : 'OK'
  };

  return result;
}

module.exports = { generateSchedule, toISTDateString };
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
    return topicNames.map(name => ({
      name: name.trim(),
      hours: hoursPerTopic
    }));
  }

  if (Array.isArray(exam.syllabusTopics) && exam.syllabusTopics.length > 0) {
    return exam.syllabusTopics.map(t => ({
      name: t.trim(),
      hours: DEFAULT_BASE_HOURS_PER_TOPIC
    })).filter(t => t.name);
  }

  return [{ name: 'General', hours: DEFAULT_BASE_HOURS_PER_TOPIC }];
};

const generateSchedule = (exams, config, missedBlocks = []) => {
  const result = { schedule: [], conflicts: [], warnings: [], metadata: {} };

  exams.forEach(exam => {
    exam.difficulty = Math.max(1, Math.min(5, exam.difficulty || 3));
    exam.currentKnowledge = Math.max(1, Math.min(5, exam.currentKnowledge || 3));
    if (!exam.priority) exam.priority = 3;
  });

  const startDate = new Date(config.startDate);
  startDate.setUTCHours(0, 0, 0, 0);
  const lastExamDate = new Date(Math.max(...exams.map(e => new Date(e.examDate))));

  const availableDaysMap = new Map();
  let currentDate = new Date(startDate);

  while (currentDate <= lastExamDate) {
    const dateStr = currentDate.toISOString().split('T')[0];
    const dayName = DAY_NAMES[currentDate.getDay()];

    const dayData = {
      date: new Date(currentDate),
      sessions: [],
      usedHours: 0,
      examCaps: {},
      totalAvailable: 0
    };

    exams.forEach(exam => {
      const examHours = exam.availableHours[dayName] || 0;
      if (examHours > 0) {
        const examKey = exam._id? exam._id.toString() : exam.subject;
        dayData.examCaps[examKey] = {
          available: examHours,
          used: 0,
          breakRatio: exam.breakRatio,
          subject: exam.subject,
          color: exam.color || '#3B82F6' // ← ADD COLOR
        };
        dayData.totalAvailable += examHours;
      }
    });

    if (dayData.totalAvailable > 0) {
      availableDaysMap.set(dateStr, dayData);
    }

    currentDate.setDate(currentDate.getDate() + 1);
  }

  const availableDays = Array.from(availableDaysMap.values()).sort((a, b) => a.date - b.date);

  const topics = [];
  let totalRequiredHours = 0;

  exams.forEach(exam => {
    const difficultyMultiplier = { 'Easy': 1, 'Medium': 1.3, 'Hard': 1.6 }[mapDifficulty(exam.difficulty)];
    const knowledgeMultiplier = 1 + (5 - exam.currentKnowledge) * 0.1;

    const topicsList = normalizeTopics(exam);
    const examId = exam._id? exam._id.toString() : exam.subject;

    const examDate = new Date(exam.examDate);
    const daysBeforeExam = availableDays.filter(d => d.date < examDate && d.examCaps[examId]).length;
    const maxDailyHours = Math.max(...Object.values(exam.availableHours), 0);
    const maxPossibleHours = daysBeforeExam * maxDailyHours;

    topicsList.forEach(topic => {
      const adjustedHoursPerTopic = topic.hours * difficultyMultiplier * knowledgeMultiplier;

      if (adjustedHoursPerTopic > maxPossibleHours && maxPossibleHours > 0) {
        result.conflicts.push({
          type: 'TOPIC_IMPOSSIBLE',
          message: `Topic "${topic.name}" in ${exam.subject} needs ${adjustedHoursPerTopic.toFixed(1)}h but only ${maxPossibleHours.toFixed(1)}h possible before exam.`,
          examName: exam.subject,
          topicName: topic.name,
          required: adjustedHoursPerTopic,
          maxPossible: maxPossibleHours,
          daysBeforeExam,
          maxDailyHours
        });
      }

      totalRequiredHours += adjustedHoursPerTopic;

      topics.push({
        examId,
        examName: exam.subject,
        examDate: exam.examDate,
        color: exam.color || '#3B82F6', // ← ADD COLOR
        topicName: topic.name,
        baseHoursPerTopic: topic.hours,
        adjustedHoursPerTopic,
        hoursRemaining: adjustedHoursPerTopic,
        difficulty: exam.difficulty,
        knowledgeLevel: exam.currentKnowledge,
        userPriority: exam.priority || 3,
        daysUntilExam: Math.ceil((new Date(exam.examDate) - startDate) / (1000 * 60 * 60 * 24)),
        breakRatio: exam.breakRatio
      });
    });
  });

  const totalAvailableHours = availableDays.reduce((sum, day) => sum + day.totalAvailable, 0);

  if (totalRequiredHours > totalAvailableHours) {
    const deficit = totalRequiredHours - totalAvailableHours;
    result.conflicts.push({
      type: 'INSUFFICIENT_TIME',
      message: `Need ${deficit.toFixed(1)} more hours total. Add more daily hours, reduce topics, or lower difficulty.`,
      required: totalRequiredHours,
      available: totalAvailableHours,
      deficit
    });
  }

  if (result.conflicts.some(c => c.type === 'TOPIC_IMPOSSIBLE')) {
    result.metadata = {
      totalRequiredHours,
      totalAvailableHours,
      status: 'FAILED_VALIDATION'
    };
    return result;
  }

  missedBlocks.forEach(missed => {
    const topic = topics.find(t => t.topicName === missed.topic && t.examName === missed.subject);
    if (topic) {
      topic.hoursRemaining += missed.duration / 60;
      totalRequiredHours += missed.duration / 60;
    }
  });

  const sortedTopics = topics
   .filter(t => t.hoursRemaining > 0)
   .sort((a, b) => {
      if (a.userPriority!== b.userPriority) return a.userPriority - b.userPriority;
      if (a.daysUntilExam!== b.daysUntilExam) return a.daysUntilExam - b.daysUntilExam;
      return b.hoursRemaining - a.hoursRemaining;
    });

  for (const topic of sortedTopics) {
    let hoursToSchedule = topic.hoursRemaining;

    for (const day of availableDays) {
      if (hoursToSchedule <= 0) break;
      if (day.date >= new Date(topic.examDate)) continue;

      const examCap = day.examCaps[topic.examId];
      if (!examCap) continue;

      let examDayRemaining = examCap.available - examCap.used;
      if (examDayRemaining < MIN_BLOCK_HOURS) continue;

      const globalBreakRatio = config.breakRatio || examCap.breakRatio || { study: 50, break: 10 };
      const studyMinutes = globalBreakRatio.study;
      const breakMinutes = globalBreakRatio.break;
      const blockHours = studyMinutes / 60;
      const breakHours = breakMinutes / 60;

      while (hoursToSchedule >= MIN_BLOCK_HOURS && examDayRemaining >= MIN_BLOCK_HOURS) {
        let currentMinutes = config.startHour * 60 + day.usedHours * 60;
        if (currentMinutes + studyMinutes > config.endHour * 60) break;

        const actualStudyHours = Math.min(blockHours, hoursToSchedule, examDayRemaining);
        const actualStudyMinutes = actualStudyHours * 60;

        if (actualStudyMinutes < MIN_BLOCK_HOURS * 60) break;

        const startHour = Math.floor(currentMinutes / 60);
        const startMin = Math.round(currentMinutes % 60);
        const startTime = `${String(startHour).padStart(2, '0')}:${String(startMin).padStart(2, '0')}`;

        const studyStartDateTime = new Date(day.date);
        studyStartDateTime.setUTCHours(startHour, startMin, 0, 0);

        day.sessions.push({
          type: 'Study',
          examId: topic.examId,
          examName: topic.examName,
          color: topic.color, // ← ADD COLOR
          topicName: topic.topicName,
          hours: actualStudyHours,
          priority: topic.userPriority,
          date: studyStartDateTime,
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

        const canAddBreak = currentMinutes + breakMinutes <= config.endHour * 60 && examDayRemaining > 0.01;

        if (canAddBreak) {
          const breakStartHour = Math.floor(currentMinutes / 60);
          const breakStartMin = Math.round(currentMinutes % 60);
          const breakStartTime = `${String(breakStartHour).padStart(2, '0')}:${String(breakStartMin).padStart(2, '0')}`;

          const breakStartDateTime = new Date(day.date);
          breakStartDateTime.setUTCHours(breakStartHour, breakStartMin, 0, 0);

          day.sessions.push({
            type: 'Break',
            examId: topic.examId,
            examName: topic.examName,
            color: topic.color, // ← ADD COLOR
            topicName: 'Break',
            hours: breakHours,
            date: breakStartDateTime,
            startTime: breakStartTime,
            duration: breakMinutes,
            isBreak: true,
            isGenerated: true
          });

          const actualBreakHours = Math.min(breakHours, examDayRemaining);
          examCap.used += actualBreakHours;
          day.usedHours += actualBreakHours;
          examDayRemaining -= actualBreakHours;
        } else {
          break;
        }
      }
    }

    if (hoursToSchedule > 0.1) {
      result.warnings.push({
        topic: `${topic.examName} - ${topic.topicName}`,
        message: `Could not schedule ${hoursToSchedule.toFixed(1)}h. Need more time before exam.`,
        hoursUnscheduled: hoursToSchedule
      });
    }
  }

  // SPACED REPETITION - BUG FIX #1 & #2
  availableDays.forEach(day => {
    day.sessions.filter(s => s.type === 'Study').forEach(session => {
      const examCap = day.examCaps[session.examId];
      if (!examCap) return;

      SPACED_INTERVALS.forEach(interval => {
        const reviewDate = new Date(day.date);
        reviewDate.setDate(reviewDate.getDate() + interval);
        const reviewDateStr = reviewDate.toISOString().split('T')[0];

        const reviewDay = availableDays.find(d =>
          d.date.toISOString().split('T')[0] === reviewDateStr
        );

        const matchingExam = exams.find(e => {
          const eId = e._id? e._id.toString() : e.subject;
          return eId === session.examId;
        });

        // BUG FIX #1: Don't schedule review on/after exam day
        const dayBeforeExam = new Date(matchingExam.examDate);
        dayBeforeExam.setDate(dayBeforeExam.getDate() - 1);
        dayBeforeExam.setHours(23, 59, 59, 999);

        if (reviewDay && matchingExam && reviewDate <= dayBeforeExam) {
          const reviewExamCap = reviewDay.examCaps[session.examId];
          if (!reviewExamCap) return;

          const reviewHours = 0.5;
          const reviewMinutes = reviewHours * 60;

          // BUG FIX #2: Check both exam cap AND day end time
          if (reviewExamCap.available - reviewExamCap.used >= reviewHours) {
            let currentMinutes = config.startHour * 60 + reviewDay.usedHours * 60;
            if (currentMinutes + reviewMinutes > config.endHour * 60) return; // Past day end

            const remainingDayHours = (config.endHour * 60 - currentMinutes) / 60;
            if (remainingDayHours < reviewHours) return; // Not enough room in day

            const startHour = Math.floor(currentMinutes / 60);
            const startMin = Math.round(currentMinutes % 60);
            const startTime = `${String(startHour).padStart(2, '0')}:${String(startMin).padStart(2, '0')}`;

            const reviewStartDateTime = new Date(reviewDay.date);
            reviewStartDateTime.setUTCHours(startHour, startMin, 0, 0);

            reviewDay.sessions.push({
              type: 'Review',
              examId: session.examId,
              examName: session.examName,
              color: session.color, // ← ADD COLOR
              topicName: session.topicName,
              hours: reviewHours,
              intervalDay: interval,
              date: reviewStartDateTime,
              startTime,
              duration: reviewMinutes,
              isBreak: false,
              isGenerated: true
            });
            reviewExamCap.used += reviewHours;
            reviewDay.usedHours += reviewHours;
          }
        }
      });
    });
  });

  result.schedule = availableDays.map(day => ({
    date: day.date,
    sessions: day.sessions.sort((a, b) => a.startTime.localeCompare(b.startTime))
  }));

  result.metadata = {
    totalRequiredHours,
    totalAvailableHours,
    status: result.conflicts.length > 0? 'HAS_CONFLICTS' : 'OK',
    topicsBreakdown: topics.map(t => ({
      examId: t.examId,
      examName: t.examName,
      topicName: t.topicName,
      baseHours: t.baseHoursPerTopic,
      adjustedHours: t.adjustedHoursPerTopic,
      difficulty: t.difficulty,
      knowledgeLevel: t.knowledgeLevel,
      priority: t.userPriority,
      color: t.color
    })),
    exams: exams.map(e => ({
      subject: e.subject,
      examDate: e.examDate,
      difficulty: e.difficulty,
      currentKnowledge: e.currentKnowledge,
      priority: e.priority,
      availableHours: e.availableHours,
      breakRatio: e.breakRatio,
      color: e.color,
      mode: e.totalHours? 'subject' : 'topic'
    }))
  };

  return result;
};

module.exports = { generateSchedule };
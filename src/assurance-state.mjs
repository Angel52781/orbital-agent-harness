const latest = (items, allowed) => {
  const last = items.at(-1)?.verdict ?? null;
  return allowed.includes(last) ? last : 'UNOBSERVED';
};

/**
 * Technical execution, domain approval, host authorization and measured
 * product outcomes are independent milestones. Never derive a genuine
 * capture or completed study from a green worker wrapper or an active timer.
 */
export function summarizeAssuranceState({
  graphState = 'UNOBSERVED', controllerTerminal = 'UNOBSERVED',
  qaVerdicts = [], releaseVerdicts = [],
  markerAuthorization = 'UNOBSERVED', firstVerifiedSampleCount = null,
  totalSlots = null, completedSlots = null, explicitStudyComplete = false
} = {}) {
  const qa = latest(qaVerdicts, ['QA_GO', 'QA_BLOCK', 'BLOCK', 'FAIL']);
  const release = latest(releaseVerdicts, ['PASS', 'FAIL', 'BLOCKED']);
  const positiveSample = Number.isInteger(firstVerifiedSampleCount) && firstVerifiedSampleCount > 0;
  const fullyCounted = Number.isInteger(totalSlots) && totalSlots > 0
    && Number.isInteger(completedSlots) && completedSlots === totalSlots;
  let overall = 'UNVERIFIED';
  if (controllerTerminal === 'BLOCKED' || controllerTerminal === 'FAIL'
      || ['QA_BLOCK', 'BLOCK', 'FAIL'].includes(qa)
      || ['FAIL', 'BLOCKED'].includes(release)) {
    overall = 'BLOCKED';
  } else if (controllerTerminal === 'PASS' && qa === 'QA_GO' && release === 'PASS') {
    if (markerAuthorization === 'AUTHORIZED') {
      overall = positiveSample ? 'FIRST_VERIFIED_REAL_SAMPLE' : 'ARMED_BOOTSTRAP';
      if (explicitStudyComplete === true && positiveSample && fullyCounted) {
        overall = 'STUDY_COMPLETED_WITH_VERIFIED_SAMPLES';
      }
    } else {
      overall = 'RELEASE_ACCEPTED_MARKER_NOT_VERIFIED';
    }
  } else if (graphState === 'PASS') {
    overall = 'GRAPH_EXECUTED_WITHOUT_DOMAIN_RELEASE';
  }
  return {
    schema: 'orbital.assurance-milestones.v1',
    workerExecution: graphState,
    innerQa: qa,
    innerRelease: release,
    controllerTerminal,
    markerAuthorization,
    firstRealSample: firstVerifiedSampleCount === null ? 'UNOBSERVED'
      : positiveSample ? 'VERIFIED' : 'NOT_YET_VERIFIED',
    studyComplete: overall === 'STUDY_COMPLETED_WITH_VERIFIED_SAMPLES',
    overall
  };
}

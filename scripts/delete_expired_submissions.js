const { getDb } = require('./sync_firestore_to_github');

// Retention periods from the privacy policy. Approved and published
// submissions are never deleted here.
const RETENTION_MONTHS = { rejected: 6, pending: 12 };

// True once a rejected or pending submission is past its retention period.
// A submission without a readable timestamp is kept.
function isExpired(data, now) {
  const start = data.status === 'rejected' ? data.rejectedAt
    : data.status === 'pending' ? (data.lastEdited ?? data.createdAt)
    : null;
  if (typeof start?.toDate !== 'function') return false;
  // Month ends roll forward (31 Aug + 6 months = 3 Mar), never earlier.
  const expiry = start.toDate();
  expiry.setUTCMonth(expiry.getUTCMonth() + RETENTION_MONTHS[data.status]);
  return expiry <= now;
}

// Logs counts only: no lyric text, document IDs or user IDs.
async function deleteExpired({ dryRun = true, now = new Date() } = {}, db = getDb()) {
  // A single-field query needs no composite index; dates are checked in code.
  const snapshot = await db.collection('submissions')
    .where('status', 'in', ['rejected', 'pending'])
    .select('status', 'rejectedAt', 'lastEdited', 'createdAt')
    .get();
  const expired = snapshot.docs.filter(doc => isExpired(doc.data(), now));
  const rejected = expired.filter(doc => doc.data().status === 'rejected').length;
  console.log(`Past retention: ${rejected} rejected, ${expired.length - rejected} inactive pending.`);

  if (dryRun) {
    console.log('Dry run, nothing deleted.');
    return expired.length;
  }
  for (const doc of expired) {
    // Fails rather than deletes if the submission changed since it was read,
    // for example if it was approved in the meantime.
    await doc.ref.delete({ lastUpdateTime: doc.updateTime });
  }
  console.log(`Deleted ${expired.length} submissions.`);
  return expired.length;
}

if (require.main === module) {
  deleteExpired({ dryRun: !process.argv.includes('--delete') }).catch(err => {
    console.error('Error deleting expired submissions:', err);
    process.exit(1);
  });
}

module.exports = { deleteExpired, isExpired };

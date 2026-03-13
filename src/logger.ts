import fs from 'fs';
import path from 'path';

const LOG_DIR = process.env.LOG_DIR || './logs';
const ADMIN_LOG_FILE = path.join(LOG_DIR, 'admin.log');

// Ensure log directory exists on startup
if (!fs.existsSync(LOG_DIR)) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

/**
 * Append a structured line to the admin action log file.
 * Format: [ISO timestamp] ADMIN:<id> | <action> | <details>
 */
export function logAdminAction(adminId: number, action: string, details?: string): void {
  const timestamp = new Date().toISOString();
  const line = details
    ? `[${timestamp}] ADMIN:${adminId} | ${action} | ${details}\n`
    : `[${timestamp}] ADMIN:${adminId} | ${action}\n`;

  try {
    fs.appendFileSync(ADMIN_LOG_FILE, line, 'utf8');
  } catch (err) {
    console.error('⚠️ Failed to write admin log:', err);
  }

  // Mirror to console as well
  console.log(`📋 ${line.trim()}`);
}

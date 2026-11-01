import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(process.env.PIWEB_SOURCE || 'upstream');
const read = name => fs.readFileSync(path.join(root, name), 'utf8');

test('completion, image, background and dialog paths contain no audio module', () => {
  for (const name of ['components/AppShell.tsx', 'components/ChatWindow.tsx', 'components/ChatInput.tsx', 'components/SessionSidebar.tsx', 'hooks/useAudio.ts']) {
    assert.doesNotMatch(read(name), /useAudio|playDoneSound|soundEnabled|onSoundToggle|onAudioUnlock|unlockAudio|onBackgroundTaskDone|AudioContext|createOscillator|pi-sound-enabled/, name);
  }
  assert.match(read('components/ChatWindow.tsx'), /onAgentEnd, onAttentionNeeded, onSessionCreated/);
  assert.match(read('components/SessionSidebar.tsx'), /completedWithNotifications\.forEach\(\(id\) => next\.add\(id\)\)/);
  assert.match(read('components/AppShell.tsx'), /showBrowserNotification\(/);
});

test('both page and push system notifications request silence', () => {
  assert.match(read('lib/browser-notifications.ts'), /const notificationOptions: NotificationOptions = \{\s*silent: true,/);
  assert.match(read('public/sw.js'), /showNotification\(title, \{\s*silent: true,/);
});

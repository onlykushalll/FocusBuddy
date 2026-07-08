import { initializeApp } from 'firebase/app';
import { getAuth } from 'firebase/auth';
import { getFirestore, enableIndexedDbPersistence } from 'firebase/firestore';
import firebaseConfig from '../firebase-applet-config.json';

const app = initializeApp(firebaseConfig);

export const auth = getAuth(app);
export const db = getFirestore(app, firebaseConfig.firestoreDatabaseId);

// Enable offline persistence ONLY for admin devices (buddy devices should not cache).
// Was previously checked once at module-load time against whatever active_role
// happened to be left in localStorage from the PREVIOUS session — on a device
// used for both roles (like during testing), this was essentially random,
// disconnected from what the user is actually doing in the current session.
// enableIndexedDbPersistence() can only be called once, before any other
// Firestore operation on this client — so this still only fires once, but now
// at least reads the role at the correct moment: right after it's actually set,
// not a stale leftover value.
if (typeof window !== 'undefined') {
  const role = localStorage.getItem('active_role');
  if (role === 'ADMIN') {
    enableIndexedDbPersistence(db).catch((err) => {
      if (err.code === 'failed-precondition') {
        console.warn('Firestore persistence failed: multiple tabs open');
      } else if (err.code === 'unimplemented') {
        console.warn('Firestore persistence is not supported by this browser');
      }
    });
  }
}

/**
 * Call this immediately after localStorage.setItem('active_role', 'ADMIN') —
 * i.e. right when a role is actually chosen this session, not just at
 * whatever stale value happened to exist at page load. Safe to call multiple
 * times; enableIndexedDbPersistence() itself is idempotent-safe to attempt
 * again (rejects harmlessly if already enabled or already too late).
 */
export function enablePersistenceIfAdmin(): void {
  if (typeof window === 'undefined') return;
  if (localStorage.getItem('active_role') !== 'ADMIN') return;
  enableIndexedDbPersistence(db).catch((err) => {
    if (err.code === 'failed-precondition') {
      console.warn('Firestore persistence failed: multiple tabs open, or already attempted this session');
    } else if (err.code === 'unimplemented') {
      console.warn('Firestore persistence is not supported by this browser');
    }
  });
}

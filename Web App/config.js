// Google OAuth web client for lotusplanner.com
//
// Web application OAuth client in project neon-concord-448921-g1
// (project number 1079954098512), shared with the iOS app.
//
// Authorized JavaScript origins:
//   https://www.lotusplanner.com
//   https://lotusplanner.com
//   http://localhost:8080
//
// The iOS client ID cannot be reused in the browser.
window.LOTUS_CONFIG = {
    googleClientId: '1079954098512-n7bhc7pi3o21tai58g476s68o2jcnfo4.apps.googleusercontent.com',
    // Reuse Pocky Apps' public Firebase Web app registration and existing user records.
    firebase: {
        apiKey: 'AIzaSyAE74ZxupN5q5KbIrmTvFnm2yky4OnVors',
        authDomain: 'life-planner-f0134.firebaseapp.com',
        projectId: 'life-planner-f0134',
        storageBucket: 'life-planner-f0134.firebasestorage.app',
        messagingSenderId: '57322603129',
        appId: '1:57322603129:web:c549e9504a530e62750aa8',
    },
    logs: { schema: 'pocky', schemaVersion: 1, rootCollection: 'users' },
};

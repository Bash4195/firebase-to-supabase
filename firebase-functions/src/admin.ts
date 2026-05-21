const admin = require("firebase-admin")

// Initialize the app once here
admin.initializeApp()
// Enable functions to connect to dev environment stuff (like firestore and auth) instead of the emulators - comment out before deploying
// const serviceAccount = require("../dev-flavorish-firebase-adminsdk-st7jz-004d3a4eec.json");
// admin.initializeApp({
//   credential: admin.credential.cert(serviceAccount),
//   databaseURL: "https://dev-flavorish.firebaseio.com"
// });

// Export the initialized admin object
export { admin }

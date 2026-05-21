// The Firebase Admin SDK to access Firestore.
const {initializeApp} = require("firebase-admin/app");

initializeApp();

const { onUserCreate, onUserDelete, changeUserEmail } = require("./auth")

exports.onUserCreate = onUserCreate
exports.onUserDelete = onUserDelete
exports.changeUserEmail = changeUserEmail

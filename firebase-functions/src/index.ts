// The Firebase Admin SDK to access Firestore.
const {initializeApp} = require("firebase-admin/app");

initializeApp();

const { onUserCreate, onUserDelete, changeUserEmail } = require("./auth")
const { onRecipeCreate, onRecipeUpdate, onRecipeDelete } = require("./recipes")

// Auth
exports.onUserCreate = onUserCreate
exports.onUserDelete = onUserDelete
exports.changeUserEmail = changeUserEmail

// Recipes
exports.onRecipeCreate = onRecipeCreate
exports.onRecipeUpdate = onRecipeUpdate
exports.onRecipeDelete = onRecipeDelete

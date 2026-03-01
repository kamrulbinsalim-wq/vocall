// ============================================================
// VoCall — firebase-messaging-sw.js
//
// ⚠️ গুরুত্বপূর্ণ নোট:
// index.html-এ FCM token নেওয়া হয় sw.js-এর registration দিয়ে।
// তাই সব Push/Notification handling sw.js-এ করা হয়েছে।
//
// এই ফাইলটি শুধু Firebase SDK-এর default fallback হিসেবে
// register থাকে। এখানে duplicate push handler রাখা হয়নি
// কারণ তাহলে একই notification দুইবার আসতো।
// ============================================================

importScripts('https://www.gstatic.com/firebasejs/9.22.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/9.22.0/firebase-messaging-compat.js');

firebase.initializeApp({
  apiKey: "AIzaSyAMCmZBxZoha4gWB5elP0p3qz1LHjTXo9s",
  authDomain: "infobooks-4358d.firebaseapp.com",
  projectId: "infobooks-4358d",
  storageBucket: "infobooks-4358d.firebasestorage.app",
  messagingSenderId: "938954145740",
  appId: "1:938954145740:web:ee2a334f8f0e621f552769"
});

// messaging object initialize করি — SDK-এর জন্য দরকার
// কিন্তু এখানে onBackgroundMessage বা notificationclick
// register করা হচ্ছে না, কারণ সব কিছু sw.js-এ handle হচ্ছে।
const messaging = firebase.messaging();

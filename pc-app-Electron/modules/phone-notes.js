'use strict';
/**
 * 手机备注管理模块
 * 
 * 用法:
 *   const phoneNotes = require('./modules/phone-notes');
 *   const note = phoneNotes.loadPhoneNote(appSettings, pin, name);
 *   phoneNotes.savePhoneNote(appSettings, pin, name, '我的手机');
 */

function getPhoneNoteKey(pin, name) {
  return pin + '|' + name;
}

function loadPhoneNote(appSettings, pin, name) {
  const notes = appSettings.phoneNotes || {};
  return notes[getPhoneNoteKey(pin, name)] || '';
}

function savePhoneNote(appSettings, pin, name, note) {
  if (!appSettings.phoneNotes) appSettings.phoneNotes = {};
  appSettings.phoneNotes[getPhoneNoteKey(pin, name)] = note;
}

module.exports = {
  getPhoneNoteKey,
  loadPhoneNote,
  savePhoneNote
};

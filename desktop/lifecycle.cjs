'use strict';
function restoreMainWindow(window){
  if(!window||window.isDestroyed?.())return;
  if(window.isMinimized())window.restore();
  window.show();window.focus();
}
module.exports={restoreMainWindow};

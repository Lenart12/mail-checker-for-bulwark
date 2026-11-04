// Run inside an open Bulwark tab; the last value is the answer. Bulwark only plays its new mail
// sound on the mail page with the Inbox showing, and the browser blocks a page's sound until it's been clicked.
navigator.userActivation?.hasBeenActive === true && /\/mail(\/folder\/inbox)?\/?$/.test(location.pathname);

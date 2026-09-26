// Login page: reveal the error banner after a failed attempt (?error=1). Served before authentication.
const loginError = document.getElementById('errorMessage');
if (loginError && new URLSearchParams(window.location.search).has('error')) {
  loginError.hidden = false;
}

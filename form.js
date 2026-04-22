(function () {
  var scriptEl = document.currentScript;

  function parseListIds(value) {
    if (!value) return [];
    return value
      .split(",")
      .map(function (v) {
        return v.trim();
      })
      .filter(Boolean);
  }

  function parseBoolean(value, defaultValue) {
    if (value === undefined || value === null || value === "") return defaultValue;
    return String(value).toLowerCase() !== "false";
  }

  function parseNewsletters(value) {
    if (!value) return [];
    try {
      var parsed = JSON.parse(value);
      if (!Array.isArray(parsed)) return [];
      return parsed
        .filter(function (item) {
          return item && item.key && item.label;
        })
        .map(function (item) {
          return { key: String(item.key), label: String(item.label) };
        });
    } catch (err) {
      return [];
    }
  }

  var datasetConfig = {
    clientId: scriptEl && scriptEl.dataset ? scriptEl.dataset.clientId : "",
    redirectUri: scriptEl && scriptEl.dataset ? scriptEl.dataset.redirectUri : window.location.origin + window.location.pathname,
    listIds: parseListIds(scriptEl && scriptEl.dataset ? scriptEl.dataset.listIds : ""),
    backendEndpoint: scriptEl && scriptEl.dataset ? scriptEl.dataset.backendEndpoint : "",
    newsletters: parseNewsletters(scriptEl && scriptEl.dataset ? scriptEl.dataset.newsletters : ""),
    target: scriptEl && scriptEl.dataset ? scriptEl.dataset.target : "",
    showListSelector: parseBoolean(scriptEl && scriptEl.dataset ? scriptEl.dataset.showListSelector : undefined, true)
  };

  var defaults = {
    authUrl: "https://authz.constantcontact.com/oauth2/default/v1/authorize",
    tokenUrl: "https://authz.constantcontact.com/oauth2/default/v1/token",
    signupUrl: "https://api.cc.email/v3/contacts/sign_up_form",
    listsUrl: "https://api.cc.email/v3/contact_lists",
    scope: "contact_data offline_access"
  };

  var config = Object.assign({}, defaults, datasetConfig, window.CC_FORM_CONFIG || {});
  var useBackend = Boolean(config.backendEndpoint);
  var keySuffix = config.clientId || "default";
  var storage = {
    accessToken: "ctct_access_token_" + keySuffix,
    refreshToken: "ctct_refresh_token_" + keySuffix,
    tokenExpiresAt: "ctct_token_expires_at_" + keySuffix,
    codeVerifier: "ctct_code_verifier_" + keySuffix,
    state: "ctct_state_" + keySuffix
  };

  function injectStyles() {
    if (document.getElementById("cc-embed-styles")) return;
    var style = document.createElement("style");
    style.id = "cc-embed-styles";
    style.textContent =
      ".ccf-widget{max-width:420px;padding:16px;border:1px solid #d7dce2;border-radius:10px;background:#fff;font-family:Segoe UI,Arial,sans-serif}" +
      ".ccf-title{margin:0 0 12px;font-size:20px}" +
      ".ccf-field,.ccf-button,.ccf-consent,.ccf-list-option{display:block;width:100%;margin-bottom:10px}" +
      ".ccf-field{box-sizing:border-box;padding:10px;border:1px solid #c7d0db;border-radius:8px}" +
      ".ccf-button{padding:10px 12px;border:0;border-radius:8px;background:#0067b8;color:#fff;cursor:pointer}" +
      ".ccf-button[disabled]{opacity:.6;cursor:not-allowed}" +
      ".ccf-list-wrap{margin:10px 0;padding:10px;border:1px solid #e3e8ee;border-radius:8px;max-height:180px;overflow:auto}" +
      ".ccf-consent input{margin-right:8px}" +
      ".ccf-message{margin:8px 0 12px;font-size:14px}" +
      ".ccf-message.error{color:#b42318}" +
      ".ccf-message.success{color:#0a7a2f}" +
      ".ccf-toast{position:fixed;max-width:360px;padding:12px 14px;border-radius:14px;background:rgba(196,71,71,.9);color:#fff;font-size:14px;line-height:1.4;box-shadow:0 8px 24px rgba(16,24,40,.22);opacity:0;transform:translateY(10px);pointer-events:none;transition:opacity .2s ease,transform .2s ease;z-index:2147483647}" +
      ".ccf-toast.show{opacity:1;transform:translateY(0)}";
    document.head.appendChild(style);
  }

  function getOrCreateToast() {
    var toast = document.querySelector(".ccf-toast");
    if (toast) return toast;

    toast = document.createElement("div");
    toast.className = "ccf-toast";
    toast.setAttribute("role", "alert");
    toast.setAttribute("aria-live", "assertive");
    document.body.appendChild(toast);
    return toast;
  }

  function positionToastNearForm(toast, root) {
    if (!toast || !root) return;

    var widget = root.querySelector(".ccf-widget") || root;
    var rect = widget.getBoundingClientRect();
    var gap = 12;
    var desiredLeft = rect.right + gap;
    var desiredTop = rect.top;

    toast.style.left = desiredLeft + "px";
    toast.style.top = desiredTop + "px";
    toast.style.right = "auto";
    toast.style.bottom = "auto";

    var toastRect = toast.getBoundingClientRect();
    var rightEdge = desiredLeft + toastRect.width;

    if (rightEdge > window.innerWidth - 12) {
      toast.style.left = Math.max(12, rect.left) + "px";
      toast.style.top = Math.min(window.innerHeight - toastRect.height - 12, rect.bottom + gap) + "px";
    }
  }

  function showToast(text, root) {
    var toast = getOrCreateToast();
    toast.textContent = text;
    positionToastNearForm(toast, root);
    toast.classList.add("show");
  }

  function isConnectionFailure(err) {
    if (!err) return false;
    var message = String(err && err.message ? err.message : err).toLowerCase();
    return (
      err.name === "TypeError" ||
      /failed to fetch|networkerror|network request failed|load failed|fetch failed|offline|timeout|ecconnrefused|enotfound/.test(message)
    );
  }

  function setFormOffline(root, messageEl) {
    var form = root.querySelector(".ccf-form");
    if (form) {
      Array.from(form.elements).forEach(function (el) {
        el.disabled = true;
      });
    }

    var connectButton = root.querySelector(".ccf-connect");
    if (connectButton) connectButton.disabled = true;

    setMessage(messageEl, "The form is offline right now. Please try again later.", "error");
    showToast("The form is offline right now. Please try again later.", root);
  }

  function createRoot() {
    if (config.target) {
      var targetNode = document.querySelector(config.target);
      if (targetNode) return targetNode;
    }

    var root = document.createElement("div");
    if (scriptEl && scriptEl.parentNode) {
      scriptEl.parentNode.insertBefore(root, scriptEl.nextSibling);
    } else {
      document.body.appendChild(root);
    }
    return root;
  }

  function getAccessToken() {
    return localStorage.getItem(storage.accessToken);
  }

  function getRefreshToken() {
    return localStorage.getItem(storage.refreshToken);
  }

  function getTokenExpiresAt() {
    return Number(localStorage.getItem(storage.tokenExpiresAt) || "0");
  }

  function isTokenExpired() {
    var expiresAt = getTokenExpiresAt();
    if (!expiresAt) return false;
    return Date.now() > expiresAt - 60 * 1000;
  }

  function setAccessToken(accessToken, refreshToken, expiresInSeconds) {
    localStorage.setItem(storage.accessToken, accessToken);
    if (refreshToken) localStorage.setItem(storage.refreshToken, refreshToken);
    if (expiresInSeconds) {
      localStorage.setItem(storage.tokenExpiresAt, String(Date.now() + Number(expiresInSeconds) * 1000));
    }
  }

  function randomString(length) {
    var chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";
    var bytes = crypto.getRandomValues(new Uint8Array(length || 64));
    return Array.from(bytes, function (x) {
      return chars[x % chars.length];
    }).join("");
  }

  function sha256Base64Url(input) {
    var data = new TextEncoder().encode(input);
    return crypto.subtle.digest("SHA-256", data).then(function (hash) {
      var bytes = new Uint8Array(hash);
      var text = "";
      bytes.forEach(function (b) {
        text += String.fromCharCode(b);
      });
      return btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    });
  }

  function getSelectedListIds(root) {
    var selected = Array.from(root.querySelectorAll('input[name="selected_lists"]:checked')).map(function (el) {
      return el.value;
    });

    return selected.length ? selected : config.listIds;
  }

  function getSelectedNewsletterKeys(root) {
    return Array.from(root.querySelectorAll('input[name="newsletter_keys"]:checked')).map(function (el) {
      return el.value;
    });
  }

  function setMessage(messageEl, text, type) {
    messageEl.className = "ccf-message" + (type ? " " + type : "");
    messageEl.textContent = text || "";
  }

  function clearOAuthQueryParams() {
    var url = new URL(window.location.href);
    url.searchParams.delete("code");
    url.searchParams.delete("state");
    url.searchParams.delete("error");
    window.history.replaceState({}, document.title, url.pathname + url.search + url.hash);
  }

  function startOAuth() {
    if (!config.clientId || !config.redirectUri) {
      throw new Error("Missing client configuration: clientId and redirectUri are required.");
    }

    var codeVerifier = randomString(64);
    var state = randomString(32);

    sessionStorage.setItem(storage.codeVerifier, codeVerifier);
    sessionStorage.setItem(storage.state, state);

    return sha256Base64Url(codeVerifier).then(function (challenge) {
      var params = new URLSearchParams({
        client_id: config.clientId,
        redirect_uri: config.redirectUri,
        response_type: "code",
        code_challenge: challenge,
        code_challenge_method: "S256",
        scope: config.scope,
        state: state
      });

      window.location.href = config.authUrl + "?" + params.toString();
    });
  }

  function exchangeCodeForToken(code, stateFromUrl) {
    var codeVerifier = sessionStorage.getItem(storage.codeVerifier);
    var expectedState = sessionStorage.getItem(storage.state);

    if (!codeVerifier || !expectedState || expectedState !== stateFromUrl) {
      return Promise.reject(new Error("Invalid OAuth state. Try Connect again."));
    }

    var body = new URLSearchParams({
      grant_type: "authorization_code",
      client_id: config.clientId,
      redirect_uri: config.redirectUri,
      code: code,
      code_verifier: codeVerifier
    });

    return fetch(config.tokenUrl, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: body
    })
      .then(function (res) {
        if (!res.ok) throw new Error("Token exchange failed: " + res.status);
        return res.json();
      })
      .then(function (data) {
        setAccessToken(data.access_token, data.refresh_token, data.expires_in);
        clearOAuthQueryParams();
      });
  }

  function refreshAccessToken() {
    var refreshToken = getRefreshToken();
    if (!refreshToken) {
      return Promise.reject(new Error("No refresh token available. Click Connect first."));
    }

    var body = new URLSearchParams({
      grant_type: "refresh_token",
      client_id: config.clientId,
      refresh_token: refreshToken
    });

    return fetch(config.tokenUrl, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: body
    })
      .then(function (res) {
        if (!res.ok) throw new Error("Token refresh failed: " + res.status);
        return res.json();
      })
      .then(function (data) {
        setAccessToken(data.access_token, data.refresh_token || refreshToken, data.expires_in);
        return data.access_token;
      });
  }

  function ensureAccessToken() {
    var token = getAccessToken();
    if (token && !isTokenExpired()) {
      return Promise.resolve(token);
    }

    return refreshAccessToken();
  }

  function fetchLists(accessToken) {
    return fetch(config.listsUrl, {
      headers: {
        Authorization: "Bearer " + accessToken
      }
    })
      .then(function (res) {
        if (!res.ok) throw new Error("Failed to fetch lists: " + res.status);
        return res.json();
      })
      .then(function (data) {
        return data.lists || [];
      });
  }

  function renderListCheckboxes(root, lists) {
    var container = root.querySelector(".ccf-list-wrap");
    if (!container) return;
    container.innerHTML = "";

    var allowedIds = config.listIds && config.listIds.length ? config.listIds : null;
    var filteredLists = allowedIds
      ? lists.filter(function (list) {
          return allowedIds.indexOf(list.list_id) > -1;
        })
      : lists;

    filteredLists.forEach(function (list) {
      var label = document.createElement("label");
      label.className = "ccf-list-option";

      var checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.name = "selected_lists";
      checkbox.value = list.list_id;

      if (config.listIds.indexOf(list.list_id) > -1) {
        checkbox.checked = true;
      }

      label.appendChild(checkbox);
      label.appendChild(document.createTextNode(" " + list.name));
      container.appendChild(label);
    });
  }

  function renderNewsletterCheckboxes(root, newsletters) {
    var container = root.querySelector(".ccf-list-wrap");
    if (!container) return;
    container.innerHTML = "";

    newsletters.forEach(function (item) {
      var label = document.createElement("label");
      label.className = "ccf-list-option";

      var checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.name = "newsletter_keys";
      checkbox.value = item.key;

      label.appendChild(checkbox);
      label.appendChild(document.createTextNode(" " + item.label));
      container.appendChild(label);
    });
  }

  function fetchBackendNewsletters() {
    return fetch(config.backendEndpoint.replace(/\/$/, "") + "/newsletters", {
      method: "GET",
      headers: {
        Accept: "application/json"
      }
    }).then(function (res) {
      if (!res.ok) throw new Error("Failed to load newsletters.");
      return res.json();
    });
  }

  function submitSignup(formData, root) {
    if (useBackend) {
      var newsletterKeys = getSelectedNewsletterKeys(root);
      if (config.showListSelector && !newsletterKeys.length) {
        return Promise.reject(new Error("Please select at least one newsletter."));
      }

      var backendPayload = {
        email: formData.get("email"),
        first_name: formData.get("first_name") || "",
        last_name: formData.get("last_name") || "",
        company_name: formData.get("company_name") || "",
        consent: Boolean(formData.get("consent")),
        newsletter_keys: newsletterKeys
      };

      return fetch(config.backendEndpoint.replace(/\/$/, "") + "/subscribe", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json"
        },
        body: JSON.stringify(backendPayload)
      }).then(function (res) {
        return res.json().then(function (data) {
          if (!res.ok) {
            throw new Error(data && data.message ? data.message : "Subscription failed.");
          }
          return data;
        });
      });
    }

    var payload = {
      email_address: formData.get("email"),
      first_name: formData.get("first_name") || "",
      last_name: formData.get("last_name") || "",
      company_name: formData.get("company_name") || "",
      list_memberships: getSelectedListIds(root)
    };

    if (!payload.list_memberships || !payload.list_memberships.length) {
      return Promise.reject(new Error("No list selected. Add list IDs or select at least one list."));
    }

    return ensureAccessToken().then(function (accessToken) {
      return fetch(config.signupUrl, {
        method: "POST",
        headers: {
          Authorization: "Bearer " + accessToken,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(payload)
      }).then(function (res) {
        return res.json().then(function (data) {
          if (!res.ok) throw new Error(JSON.stringify(data));
          return data;
        });
      });
    });
  }

  function renderWidget(root) {
    root.innerHTML =
      '<div class="ccf-widget">' +
      '<h2 class="ccf-title">Email Updates</h2>' +
      '<div class="ccf-message"></div>' +
      (useBackend ? "" : '<button type="button" class="ccf-button ccf-connect">Connect to Constant Contact</button>') +
      '<form class="ccf-form">' +
      '<input class="ccf-field" type="text" name="first_name" placeholder="First Name" required>' +
      '<input class="ccf-field" type="text" name="last_name" placeholder="Last Name" required>' +
      '<input class="ccf-field" type="email" name="email" placeholder="Email" required>' +
      '<input class="ccf-field" type="text" name="company_name" placeholder="Business/Organization (optional)">' +
      (config.showListSelector ? '<div class="ccf-list-wrap"></div>' : "") +
      '<label class="ccf-consent"><input name="consent" type="checkbox" required>I agree to receive email updates.</label>' +
      '<button class="ccf-button" type="submit">Subscribe</button>' +
      "</form>" +
      "</div>";
  }

  function init() {
    injectStyles();
    var root = createRoot();
    renderWidget(root);

    var connectButton = root.querySelector(".ccf-connect");
    var form = root.querySelector(".ccf-form");
    var message = root.querySelector(".ccf-message");

    if (!useBackend && !config.clientId) {
      setMessage(message, "Set data-client-id in the script tag.", "error");
    }

    if (connectButton) {
      connectButton.addEventListener("click", function () {
        setMessage(message, "Redirecting to Constant Contact...", "");
        startOAuth().catch(function (err) {
          setMessage(message, err.message, "error");
        });
      });
    }

    form.addEventListener("submit", function (event) {
      event.preventDefault();
      var formData = new FormData(form);

      if (!formData.get("consent")) {
        setMessage(message, "Consent is required.", "error");
        return;
      }

      submitSignup(formData, root)
        .then(function () {
          setMessage(message, "Subscribed successfully.", "success");
          form.reset();
        })
        .catch(function (err) {
          if (isConnectionFailure(err)) {
            setFormOffline(root, message);
            return;
          }
          setMessage(message, "Subscription failed: " + err.message, "error");
        });
    });

    var params = new URLSearchParams(window.location.search);
    var code = params.get("code");
    var state = params.get("state");

    if (useBackend) {
      if (config.showListSelector) {
        if (Array.isArray(config.newsletters) && config.newsletters.length) {
          renderNewsletterCheckboxes(root, config.newsletters);
        } else {
          fetchBackendNewsletters()
            .then(function (data) {
              var newsletters = Array.isArray(data.newsletters) ? data.newsletters : [];
              renderNewsletterCheckboxes(root, newsletters);
            })
            .catch(function (err) {
              if (isConnectionFailure(err)) {
                setFormOffline(root, message);
                return;
              }
              setMessage(message, "Could not load newsletter options.", "error");
            });
        }
      }
      return;
    }

    ensureAccessToken()
      .then(function (token) {
        connectButton.textContent = "Connected to Constant Contact";
        connectButton.disabled = true;

        if (config.showListSelector) {
          return fetchLists(token).then(function (lists) {
            renderListCheckboxes(root, lists);
          });
        }
      })
      .catch(function () {
        connectButton.textContent = "Connect to Constant Contact";
        connectButton.disabled = false;
      });

    if (code && state && sessionStorage.getItem(storage.codeVerifier)) {
      setMessage(message, "Finishing connection...", "");
      exchangeCodeForToken(code, state)
        .then(function () {
          setMessage(message, "Connected. You can submit the form now.", "success");
          connectButton.textContent = "Connected to Constant Contact";
          connectButton.disabled = true;
          if (config.showListSelector) {
            return fetchLists(getAccessToken()).then(function (lists) {
              renderListCheckboxes(root, lists);
            });
          }
        })
        .catch(function (err) {
          setMessage(message, err.message, "error");
        });
    }
  }

  init();
})();
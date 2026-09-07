(function () {
  "use strict";

  const MAX_RESULT_ROWS = 8;
  const DEFAULT_CONTACT_EMAIL = "bookings@pickle-street-tugbok.boothsandbeyondoffic.chatgpt.site";
  const currencyFormatter = new Intl.NumberFormat("en-PH", {
    style: "currency",
    currency: "PHP",
    minimumFractionDigits: 2,
  });
  const dateFormatter = new Intl.DateTimeFormat("en-PH", {
    timeZone: "Asia/Manila",
    weekday: "short",
    month: "long",
    day: "numeric",
    year: "numeric",
  });

  const bookingStatusMeta = {
    confirmed: {
      label: "Confirmed",
      tone: "success",
      message: "Your booking is confirmed and your court is secured.",
    },
    completed: {
      label: "Completed",
      tone: "neutral",
      message: "This booking has been completed.",
    },
    pending: {
      label: "Pending confirmation",
      tone: "warning",
      message: "Your booking was received and is waiting for final confirmation.",
    },
    verifying: {
      label: "Verification in progress",
      tone: "warning",
      message: "Your booking and payment evidence are still being checked. Please do not pay again.",
    },
    cancelled: {
      label: "Cancelled",
      tone: "danger",
      message: "This booking is cancelled and its original court time is no longer reserved.",
    },
    forfeited: {
      label: "Forfeited",
      tone: "danger",
      message: "This reservation is no longer active. Contact Pickle Street if you need help understanding its status.",
    },
  };

  const paymentStatusMeta = {
    paid: { label: "Paid in full", tone: "success" },
    downpayment_paid: { label: "Deposit recorded", tone: "success" },
    for_verification: { label: "Payment under review", tone: "warning" },
    balance_due: { label: "Balance due", tone: "warning" },
    unpaid: { label: "Payment not recorded", tone: "neutral" },
    rejected: { label: "Payment rejected", tone: "danger" },
    deposit_retained: { label: "Payment retained", tone: "danger" },
  };

  let form;
  let refInput;
  let emailInput;
  let lookupButton;
  let resultRegion;
  let formFeedback;
  let ownerPreviewBanner;
  let ownerPreviewModeButton;
  let guestAccessModeButton;
  let ownerResultNote;
  let rescheduleDialog;
  let rescheduleSheet;
  let rescheduleForm;
  let rescheduleContent;
  let rescheduleFeedback;
  let rescheduleSubmit;
  let rescheduleOwnerNotice;
  let ownerPreviewRequested = false;
  let ownerPreviewActive = false;
  let bookingContext = null;
  let rescheduleState = null;
  let rescheduleOptions = [];
  let selectedRescheduleOption = null;
  let rescheduleRestoreFocus = null;
  let rescheduleCloseTimer = 0;
  let rescheduleStateSequence = 0;
  let rescheduleOptionsSequence = 0;
  let rescheduleStatePromise = null;
  let rescheduleStateReady = false;
  let rescheduleStateError = null;
  let rescheduleRequestButton = null;
  let reschedulePolicyHeading = null;
  let reschedulePolicyCopy = null;
  let reschedulePolicyContact = null;
  let rescheduleMutationBusy = false;

  function element(tagName, className, text) {
    const node = document.createElement(tagName);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function normalizeReference(value) {
    return String(value || "")
      .trim()
      .toUpperCase()
      .replace(/\s+/g, "");
  }

  function referenceLooksValid(value) {
    return /^PB-[A-Z0-9]+(?:-[A-Z0-9]+)*$/.test(value) && value.length <= 72;
  }

  function emailLooksValid(value) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) && value.length <= 254;
  }

  function safeNumber(value) {
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? number : 0;
  }

  function formatCurrency(value) {
    return currencyFormatter.format(safeNumber(value));
  }

  function formatDate(value) {
    const raw = String(value || "").trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw || "Date unavailable";
    const date = new Date(`${raw}T12:00:00+08:00`);
    return Number.isNaN(date.getTime()) ? raw : dateFormatter.format(date);
  }

  function formatHour(hour) {
    const normalized = ((Number(hour) % 24) + 24) % 24;
    const period = normalized < 12 ? "AM" : "PM";
    const displayHour = normalized % 12 || 12;
    return `${displayHour}:00 ${period}`;
  }

  function formatTimeRange(row) {
    const slots = Array.isArray(row.slots)
      ? row.slots.map(Number).filter(Number.isFinite).sort((left, right) => left - right)
      : [];
    if (slots.length) {
      const ranges = [];
      let rangeStart = slots[0];
      let rangeEnd = slots[0];
      for (let index = 1; index < slots.length; index += 1) {
        if (slots[index] === rangeEnd + 1) {
          rangeEnd = slots[index];
        } else {
          ranges.push([rangeStart, rangeEnd]);
          rangeStart = slots[index];
          rangeEnd = slots[index];
        }
      }
      ranges.push([rangeStart, rangeEnd]);
      return ranges
        .map(([first, last]) => `${formatHour(first)} – ${formatHour(last + 1)}`)
        .join(", ");
    }

    const start = String(row.startTime || "").trim();
    const end = String(row.endTime || "").trim();
    if (start && end) return `${start} – ${end}`;
    return start || end || "Time unavailable";
  }

  function unique(values) {
    return [...new Set(values.filter(Boolean))];
  }

  function naturalList(values) {
    const list = unique(values);
    if (list.length < 2) return list[0] || "—";
    if (list.length === 2) return `${list[0]} and ${list[1]}`;
    return `${list.slice(0, -1).join(", ")}, and ${list[list.length - 1]}`;
  }

  function paymentMethodLabel(value) {
    const key = String(value || "").trim().toLowerCase();
    const labels = {
      gcash: "GCash",
      gcash_gateway: "GCash",
      maya: "Maya",
      bdopay: "BDO Pay",
      bpi: "BPI",
      gotyme: "GoTyme",
      maribank: "MariBank",
      pnb: "PNB",
      cash: "Cash",
    };
    return labels[key] || (key ? key.replace(/_/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase()) : "Not available");
  }

  function contactEmail() {
    const configured = String(
      window.PB_MANAGE_BOOKING_CONTACT_EMAIL
      || document.querySelector('meta[name="paddle-rage-contact-email"]')?.content
      || DEFAULT_CONTACT_EMAIL,
    ).trim();
    return emailLooksValid(configured) ? configured : DEFAULT_CONTACT_EMAIL;
  }

  function contactHref(reference, subjectPrefix) {
    const subject = `${subjectPrefix || "Booking help"}${reference ? ` — ${reference}` : ""}`;
    return `mailto:${encodeURIComponent(contactEmail())}?subject=${encodeURIComponent(subject)}`;
  }

  function makeContactButton(reference, label, subjectPrefix, className) {
    const link = element("a", className || "contact-button", label || "Contact Pickle Street");
    link.href = contactHref(reference, subjectPrefix);
    return link;
  }

  function ownerSignInHref() {
    const returnTo = "manage-booking.html#ownerPreview=1";
    return `login.html?next=${encodeURIComponent(returnTo)}`;
  }

  function makeOwnerSignInButton(label) {
    const link = element("a", "owner-state-action is-primary", label || "Sign in to Admin");
    link.href = ownerSignInHref();
    return link;
  }

  function idleLookupLabel() {
    return ownerPreviewActive ? "Preview booking" : "Find my booking";
  }

  function setLoading(isLoading) {
    lookupButton.disabled = isLoading;
    lookupButton.classList.toggle("is-loading", isLoading);
    lookupButton.setAttribute("aria-busy", String(isLoading));
    lookupButton.querySelector(".button-label").textContent = isLoading
      ? (ownerPreviewActive ? "Opening owner preview…" : "Finding your booking…")
      : idleLookupLabel();
    resultRegion.setAttribute("aria-busy", String(isLoading));
  }

  function clearValidation() {
    refInput.setAttribute("aria-invalid", "false");
    emailInput.setAttribute("aria-invalid", "false");
    formFeedback.textContent = "";
  }

  function validationError(input, message) {
    input.setAttribute("aria-invalid", "true");
    formFeedback.textContent = message;
    input.focus();
  }

  function focusResult() {
    window.requestAnimationFrame(() => resultRegion.focus({ preventScroll: false }));
  }

  function renderLoadingState() {
    bookingContext = null;
    rescheduleState = null;
    rescheduleStateSequence += 1;
    rescheduleOptionsSequence += 1;
    if (ownerResultNote) ownerResultNote.hidden = true;
    const card = element("div", "state-card");
    const heading = element("div", "state-heading");
    const icon = element("span", "state-icon", "…");
    icon.setAttribute("aria-hidden", "true");
    const copy = element("div");
    copy.append(
      element("h2", "", "Securely checking your booking"),
      element("p", "", "This usually takes only a moment."),
    );
    heading.append(icon, copy);
    card.append(heading);
    resultRegion.replaceChildren(card);
  }

  function renderMessageState(options) {
    bookingContext = null;
    rescheduleState = null;
    rescheduleStateSequence += 1;
    rescheduleOptionsSequence += 1;
    if (ownerResultNote) ownerResultNote.hidden = true;
    const tone = options.tone === "warning" ? "is-warning" : "is-error";
    const card = element("div", `state-card ${tone}`);
    if (options.alert !== false) card.setAttribute("role", "alert");
    const heading = element("div", "state-heading");
    const icon = element("span", "state-icon", options.tone === "warning" ? "!" : "×");
    icon.setAttribute("aria-hidden", "true");
    const copy = element("div");
    copy.append(element("h2", "", options.title), element("p", "", options.message));
    heading.append(icon, copy);
    card.append(heading);
    const actions = [];
    if (options.contact) {
      actions.push(makeContactButton(
        options.reference,
        "Contact Pickle Street",
        "Booking access help",
        "owner-state-action",
      ));
    }
    if (Array.isArray(options.actions)) actions.push(...options.actions.filter(Boolean));
    if (actions.length) {
      const actionRow = element("div", "owner-state-actions");
      actionRow.append(...actions);
      card.append(actionRow);
    }
    resultRegion.replaceChildren(card);
    focusResult();
  }

  function aggregateBookingStatus(rows) {
    const values = unique(rows.map((row) => String(row.status || "").trim().toLowerCase()));
    if (values.length === 1 && bookingStatusMeta[values[0]]) return bookingStatusMeta[values[0]];
    if (values.includes("verifying")) return bookingStatusMeta.verifying;
    if (values.includes("pending")) return bookingStatusMeta.pending;
    if (values.every((status) => status === "cancelled")) return bookingStatusMeta.cancelled;
    if (values.every((status) => status === "completed")) return bookingStatusMeta.completed;
    return {
      label: "Status update",
      tone: "neutral",
      message: "This booking contains items at different stages. Review each schedule below or contact Pickle Street for help.",
    };
  }

  function aggregatePaymentStatus(rows) {
    const values = unique(rows.map((row) => String(row.paymentStatus || "").trim().toLowerCase()));
    if (values.length === 1 && paymentStatusMeta[values[0]]) return paymentStatusMeta[values[0]];
    if (values.includes("for_verification")) return paymentStatusMeta.for_verification;
    if (values.includes("rejected")) return paymentStatusMeta.rejected;
    if (values.includes("balance_due")) return paymentStatusMeta.balance_due;
    if (values.includes("downpayment_paid") || values.includes("paid")) {
      return { label: "Partially paid", tone: "warning" };
    }
    return { label: "Payment status available", tone: "neutral" };
  }

  function paymentSummary(rows, paymentMeta) {
    const paymentStates = rows.map((row) => String(row.paymentStatus || "").trim().toLowerCase());
    const total = rows.reduce((sum, row) => sum + safeNumber(row.total), 0);
    const recorded = rows.reduce((sum, row) => {
      const state = String(row.paymentStatus || "").trim().toLowerCase();
      if (state === "paid") return sum + safeNumber(row.total);
      if (["downpayment_paid", "deposit_retained"].includes(state)) {
        return sum + Math.min(safeNumber(row.total), safeNumber(row.downpayment));
      }
      return sum;
    }, 0);
    const submitted = rows.reduce((sum, row) => sum + Math.min(safeNumber(row.total), safeNumber(row.downpayment)), 0);

    if (paymentStates.every((state) => state === "paid")) return `${formatCurrency(total)} paid`;
    if (paymentStates.some((state) => state === "for_verification")) return `${formatCurrency(submitted)} submitted for review`;
    if (recorded > 0) return `${formatCurrency(recorded)} recorded`;
    if (paymentMeta.label === "Payment not recorded") return "No payment recorded";
    return paymentMeta.label;
  }

  function makeStatusPill(meta, prefix) {
    const pill = element("span", `status-pill is-${meta.tone}`, `${prefix}: ${meta.label}`);
    return pill;
  }

  function makeSummaryItem(label, value) {
    const item = element("div", "summary-item");
    item.append(element("span", "summary-label", label), element("strong", "summary-value", value));
    return item;
  }

  function scheduleSortKey(row) {
    return [row.date, row.startTime, row.courtName, row.ref].map((value) => String(value || "")).join("|");
  }

  function makeScheduleItem(row) {
    const item = element("li", "schedule-item");
    item.append(
      element("strong", "schedule-court", String(row.courtName || "Court")),
      element("span", "schedule-date", formatDate(row.date)),
      element("span", "schedule-time", formatTimeRange(row)),
    );
    return item;
  }

  function displayReference(rows, requestedReference) {
    const groupRefs = unique(rows.map((row) => String(row.groupRef || "").trim()));
    if (groupRefs.length === 1) return groupRefs[0].replace(/-G$/i, "");
    const exactRow = rows.find((row) => normalizeReference(row.ref) === requestedReference);
    return String(exactRow?.ref || rows[0]?.ref || requestedReference).replace(/-G$/i, "");
  }

  function requestField(request, camelName, snakeName) {
    return request?.[camelName] ?? request?.[snakeName] ?? null;
  }

  function activeRequestFromState(state) {
    if (!state || typeof state !== "object") return null;
    const request = state.request && typeof state.request === "object" ? state.request : state;
    return request && requestField(request, "status", "status") ? request : null;
  }

  function rescheduleEligibility() {
    const booking = rescheduleState?.booking && typeof rescheduleState.booking === "object"
      ? rescheduleState.booking
      : {};
    const policy = booking.reschedule && typeof booking.reschedule === "object"
      ? booking.reschedule
      : {};
    return {
      known: typeof policy.eligible === "boolean",
      eligible: policy.eligible !== false,
      cutoffHours: Math.max(1, Number(policy.cutoffHours ?? policy.cutoff_hours) || 24),
    };
  }

  function applyReschedulePolicyState() {
    if (!rescheduleRequestButton || !reschedulePolicyHeading || !reschedulePolicyCopy) return;
    const request = activeRequestFromState(rescheduleState);
    const status = request ? requestStatus(request) : "";
    const eligibility = rescheduleEligibility();
    const contactShouldShow = !ownerPreviewActive && rescheduleStateReady
      && (Boolean(rescheduleStateError) || (eligibility.known && !eligibility.eligible));

    if (reschedulePolicyContact) reschedulePolicyContact.hidden = !contactShouldShow;
    rescheduleRequestButton.removeAttribute("aria-busy");

    if (ownerPreviewActive) {
      rescheduleRequestButton.disabled = false;
      rescheduleRequestButton.textContent = "Preview reschedule flow";
      return;
    }

    if (!rescheduleStateReady) {
      rescheduleRequestButton.disabled = true;
      rescheduleRequestButton.setAttribute("aria-busy", "true");
      rescheduleRequestButton.textContent = "Checking eligibility…";
      reschedulePolicyHeading.textContent = "Need to change your schedule?";
      reschedulePolicyCopy.textContent = "Securely checking your booking’s schedule-change options.";
      return;
    }

    if (rescheduleStateError) {
      rescheduleRequestButton.disabled = true;
      rescheduleRequestButton.textContent = "Online request unavailable";
      reschedulePolicyHeading.textContent = "Schedule requests are temporarily unavailable";
      reschedulePolicyCopy.textContent = "We couldn’t verify online reschedule eligibility right now. Your booking is unchanged; contact Pickle Street if you need help.";
      return;
    }

    if (request) {
      rescheduleRequestButton.disabled = false;
      rescheduleRequestButton.textContent = status === "pending"
        ? "Review pending request"
        : status === "approved"
          ? "View approved request"
          : eligibility.known && !eligibility.eligible
            ? "View previous request"
            : "Request another schedule";
      reschedulePolicyHeading.textContent = status === "pending"
        ? "Your schedule request is under review"
        : "Your schedule request has an update";
      reschedulePolicyCopy.textContent = status === "pending" && eligibility.known && !eligibility.eligible
        ? `Your request remains available to review or withdraw. New changes are unavailable inside the ${eligibility.cutoffHours}-hour cutoff.`
        : "Open the request to review its current and requested schedules, status, and available next steps.";
      return;
    }

    if (eligibility.known && !eligibility.eligible) {
      const allConfirmed = (bookingContext?.rows || []).every((row) => String(row.status || "").toLowerCase() === "confirmed");
      rescheduleRequestButton.disabled = true;
      rescheduleRequestButton.textContent = "Online request unavailable";
      reschedulePolicyHeading.textContent = "This booking can’t be changed online right now";
      reschedulePolicyCopy.textContent = allConfirmed
        ? `Online schedule requests close ${eligibility.cutoffHours} hours before the earliest booked schedule. Your booking remains confirmed.`
        : "Online schedule requests become available after every selected booking item is confirmed. Your booking has not been changed.";
      return;
    }

    rescheduleRequestButton.disabled = false;
    rescheduleRequestButton.textContent = "Request a schedule change";
    reschedulePolicyHeading.textContent = "Need to change your schedule?";
    reschedulePolicyCopy.textContent = "Choose an exact available time here. This page does not change your booking automatically; your current schedule stays confirmed until Pickle Street reviews and approves your request.";
  }

  function requestStatus(request) {
    const raw = String(requestField(request, "status", "status") || "pending").trim().toLowerCase();
    if (["approved", "accepted", "completed"].includes(raw)) return "approved";
    if (["rejected", "declined"].includes(raw)) return "rejected";
    if (["withdrawn", "cancelled", "canceled"].includes(raw)) return "withdrawn";
    if (raw === "conflicted") return "conflicted";
    if (raw === "superseded") return "superseded";
    return "pending";
  }

  function requestDate(request) {
    const schedule = requestField(request, "requestedSchedule", "requested_schedule");
    return String(requestField(request, "requestedDate", "requested_date") || schedule?.requestedDate || schedule?.requested_date || schedule?.date || "").slice(0, 10);
  }

  function requestSlots(request) {
    const schedule = requestField(request, "requestedSchedule", "requested_schedule");
    const slots = requestField(request, "requestedSlots", "requested_slots") || schedule?.requestedSlots || schedule?.requested_slots || schedule?.slots;
    return Array.isArray(slots) ? slots.map(Number).filter(Number.isFinite).sort((a, b) => a - b) : [];
  }

  function requestItemRefs(request) {
    const schedule = requestField(request, "requestedSchedule", "requested_schedule");
    const refs = requestField(request, "itemRefs", "item_refs") || schedule?.itemRefs || schedule?.item_refs;
    return Array.isArray(refs) ? refs.map(normalizeReference).filter(Boolean) : [];
  }

  function requestTimeLabel(request) {
    const slots = requestSlots(request);
    if (slots.length) return formatTimeRange({ slots });
    const schedule = requestField(request, "requestedSchedule", "requested_schedule");
    const startTime = requestField(request, "requestedStartTime", "requested_start_time") || schedule?.startTime || schedule?.start_time;
    const endTime = requestField(request, "requestedEndTime", "requested_end_time") || schedule?.endTime || schedule?.end_time;
    if (startTime && endTime) return `${startTime} – ${endTime}`;
    return "Time awaiting confirmation";
  }

  function requestScheduleSummary(request) {
    const date = requestDate(request);
    return date ? `${formatDate(date)} · ${requestTimeLabel(request)}` : requestTimeLabel(request);
  }

  function requestStatusCopy(request) {
    const status = requestStatus(request);
    const decision = requestField(request, "decision", "decision");
    const reason = String(requestField(request, "decisionReason", "decision_reason")
      || requestField(request, "rejectionReason", "rejection_reason") || decision?.reason || "").trim();
    const copy = {
      pending: {
        badge: "Pending review",
        title: "Your reschedule request was sent",
        message: "Your original schedule stays confirmed until Pickle Street approves the requested change.",
        icon: "↻",
        action: "Review or update",
      },
      approved: {
        badge: "Approved",
        title: "Your new schedule is confirmed",
        message: "Pickle Street approved this schedule change. Your booking details now reflect the confirmed schedule.",
        icon: "✓",
        action: "View request",
      },
      rejected: {
        badge: "Not approved",
        title: "Choose another available schedule",
        message: reason || "That requested schedule could not be approved. Your existing booking was not changed.",
        icon: "!",
        action: "Choose another time",
      },
      withdrawn: {
        badge: "Withdrawn",
        title: "Request withdrawn",
        message: "Your original booking remains unchanged. You may send a new request if you still need another schedule.",
        icon: "×",
        action: "Make a new request",
      },
      conflicted: {
        badge: "Time unavailable",
        title: "Please choose another schedule",
        message: reason || "That requested time became unavailable before approval. Your existing booking was not changed.",
        icon: "!",
        action: "Choose another time",
      },
      superseded: {
        badge: "Replaced",
        title: "A newer request replaced this one",
        message: "Your current booking remains unchanged unless the newer schedule request is approved.",
        icon: "↻",
        action: "Make a new request",
      },
    };
    return { status, ...copy[status] };
  }

  function makeRescheduleStatusCard(request, compact = false) {
    const meta = requestStatusCopy(request);
    const card = element("section", `reschedule-status-card is-${meta.status}`);
    card.setAttribute("aria-label", `Reschedule request: ${meta.badge}`);
    const icon = element("span", "reschedule-status-icon", meta.icon);
    icon.setAttribute("aria-hidden", "true");
    const copy = element("div", "reschedule-status-copy");
    const statusMeta = element("div", "reschedule-status-meta");
    statusMeta.append(
      element("span", "reschedule-status-kicker", "Reschedule request"),
      element("span", "reschedule-status-badge", meta.badge),
    );
    copy.append(statusMeta, element("h3", "", meta.title));
    if (!compact) {
      copy.append(
        element("p", "reschedule-status-summary", requestScheduleSummary(request)),
        element("p", "", meta.message),
      );
    }
    card.append(icon, copy);
    if (!compact) {
      const action = element("button", "reschedule-status-action", meta.action);
      action.type = "button";
      action.addEventListener("click", (event) => void openRescheduleDialog(event.currentTarget));
      card.append(action);
    }
    return card;
  }

  async function refreshRescheduleState(mount) {
    if (!bookingContext || ownerPreviewActive) return null;
    if (typeof window.DB?.getBookingRescheduleState !== "function") {
      rescheduleStateReady = true;
      rescheduleStateError = new Error("Schedule request service unavailable");
      applyReschedulePolicyState();
      return null;
    }
    const loadId = ++rescheduleStateSequence;
    rescheduleStateReady = false;
    rescheduleStateError = null;
    applyReschedulePolicyState();
    const loadPromise = window.DB.getBookingRescheduleState(bookingContext.reference, bookingContext.email);
    rescheduleStatePromise = loadPromise;
    try {
      const state = await loadPromise;
      if (loadId !== rescheduleStateSequence || !bookingContext) return;
      rescheduleState = state && typeof state === "object" ? state : null;
      rescheduleStateReady = true;
      rescheduleStateError = null;
      const request = activeRequestFromState(rescheduleState);
      if (mount) mount.replaceChildren(...(request ? [makeRescheduleStatusCard(request)] : []));
      applyReschedulePolicyState();
      return rescheduleState;
    } catch (error) {
      if (loadId === rescheduleStateSequence) {
        rescheduleState = null;
        rescheduleStateReady = true;
        rescheduleStateError = error instanceof Error ? error : new Error("Schedule request service unavailable");
        if (mount) mount.replaceChildren();
        applyReschedulePolicyState();
      }
      return null;
    } finally {
      if (rescheduleStatePromise === loadPromise) rescheduleStatePromise = null;
    }
  }

  function todayInManila() {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: "Asia/Manila",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(new Date()).reduce((result, part) => {
      result[part.type] = part.value;
      return result;
    }, {});
    return `${parts.year}-${parts.month}-${parts.day}`;
  }

  function addDays(dateValue, days) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateValue || ""));
    if (!match) return "";
    const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]) + Number(days || 0)));
    return date.toISOString().slice(0, 10);
  }

  function minimumRescheduleDate() {
    const today = todayInManila();
    const openingDate = String(document.querySelector('meta[name="paddle-rage-booking-opening-date"]')?.content || "").trim();
    return /^\d{4}-\d{2}-\d{2}$/.test(openingDate) && openingDate > today ? openingDate : today;
  }

  function sameSlots(left, right) {
    const first = (Array.isArray(left) ? left : []).map(Number).filter(Number.isFinite).sort((a, b) => a - b);
    const second = (Array.isArray(right) ? right : []).map(Number).filter(Number.isFinite).sort((a, b) => a - b);
    return first.length === second.length && first.every((value, index) => value === second[index]);
  }

  function isCurrentScheduleOption(option, date) {
    const rows = selectedBookingRows();
    return rows.length > 0 && rows.every((row) => String(row.date || "") === String(date || "") && sameSlots(row.slots, option?.slots));
  }

  function selectedBookingRefs() {
    return [...rescheduleContent.querySelectorAll('input[name="rescheduleItem"]:checked')]
      .map((input) => normalizeReference(input.value))
      .filter(Boolean);
  }

  function selectedBookingRows() {
    const selected = new Set(selectedBookingRefs());
    return (bookingContext?.rows || []).filter((row) => selected.has(normalizeReference(row.ref)));
  }

  function selectedScheduleSummary(rows) {
    if (!rows.length) return { title: "Select a schedule", detail: "Choose at least one booking item above." };
    return {
      title: naturalList(rows.map((row) => String(row.courtName || "Court"))),
      detail: naturalList(rows.map((row) => `${formatDate(row.date)} · ${formatTimeRange(row)}`)),
    };
  }

  function normalizeRescheduleOption(option, index) {
    const rawSlots = Array.isArray(option?.slots)
      ? option.slots.map(Number).filter(Number.isFinite).sort((a, b) => a - b)
      : [];
    const start = option?.startTime ?? option?.start_time ?? rawSlots[0];
    const end = option?.endTime ?? option?.end_time ?? (rawSlots.length ? rawSlots[rawSlots.length - 1] + 1 : null);
    const label = String(option?.label || "").trim()
      || (rawSlots.length ? formatTimeRange({ slots: rawSlots }) : (start !== null && end !== null ? `${start} – ${end}` : "Available time"));
    return {
      ...option,
      key: String(option?.id || option?.key || `${start}-${end}-${index}`),
      slots: rawSlots,
      startTime: start,
      endTime: end,
      label,
      available: option?.available !== false,
    };
  }

  function renderRescheduleComparison() {
    const mount = rescheduleContent.querySelector("#rescheduleComparison");
    if (!mount) return;
    const current = selectedScheduleSummary(selectedBookingRows());
    const date = rescheduleContent.querySelector("#rescheduleDate")?.value || "";
    const requestedTitle = selectedRescheduleOption
      ? selectedScheduleSummary(selectedBookingRows()).title
      : "Choose an available time";
    const requestedDetail = selectedRescheduleOption && date
      ? `${formatDate(date)} · ${selectedRescheduleOption.label}`
      : "Your requested schedule will appear here.";
    const oldCard = element("div", "reschedule-comparison-card");
    oldCard.append(
      element("span", "reschedule-comparison-label", "Current schedule"),
      element("strong", "", current.title),
      element("span", "", current.detail),
    );
    const arrow = element("span", "reschedule-comparison-arrow", "→");
    arrow.setAttribute("aria-hidden", "true");
    const newCard = element("div", "reschedule-comparison-card is-new");
    newCard.append(
      element("span", "reschedule-comparison-label", "Requested schedule"),
      element("strong", "", requestedTitle),
      element("span", "", requestedDetail),
    );
    mount.replaceChildren(oldCard, arrow, newCard);
  }

  function renderSlotOptions(options, message, isLoading = false) {
    const grid = rescheduleContent.querySelector("#rescheduleSlotGrid");
    if (!grid) return;
    const announcement = rescheduleContent.querySelector("#rescheduleAvailabilityStatus");
    grid.setAttribute("aria-busy", String(Boolean(isLoading)));
    grid.replaceChildren();
    const available = options.filter((option) => option.available);
    if (!available.length) {
      const emptyMessage = message || "No same-duration schedules are available on this date. Try another date.";
      grid.append(element("p", "reschedule-inline-state", emptyMessage));
      if (announcement) announcement.textContent = emptyMessage;
      return;
    }
    const date = rescheduleContent.querySelector("#rescheduleDate")?.value || "";
    let requestableCount = 0;
    available.forEach((option) => {
      const isCurrent = isCurrentScheduleOption(option, date);
      if (!isCurrent) requestableCount += 1;
      const button = element("button", "reschedule-slot");
      button.type = "button";
      button.dataset.optionKey = option.key;
      button.disabled = isCurrent;
      button.setAttribute("aria-pressed", String(selectedRescheduleOption?.key === option.key));
      button.classList.toggle("is-selected", selectedRescheduleOption?.key === option.key);
      button.classList.toggle("is-current", isCurrent);
      button.append(document.createTextNode(option.label), element("small", "", isCurrent ? "Current schedule · choose another" : "Available · same duration"));
      button.addEventListener("click", () => {
        if (isCurrent) return;
        selectedRescheduleOption = option;
        grid.querySelectorAll(".reschedule-slot").forEach((slot) => {
          const selected = slot.dataset.optionKey === option.key;
          slot.classList.toggle("is-selected", selected);
          slot.setAttribute("aria-pressed", String(selected));
        });
        rescheduleFeedback.textContent = "";
        renderRescheduleComparison();
      });
      grid.append(button);
    });
    if (!requestableCount) {
      const unchangedMessage = "This date only shows your current schedule. Choose another date or time.";
      grid.append(element("p", "reschedule-inline-state", unchangedMessage));
      if (announcement) announcement.textContent = unchangedMessage;
    } else if (announcement) {
      announcement.textContent = `${requestableCount} available ${requestableCount === 1 ? "time" : "times"} found for the selected schedule.`;
    }
  }

  async function loadRescheduleOptions() {
    const dateInput = rescheduleContent.querySelector("#rescheduleDate");
    const date = dateInput?.value || "";
    const itemRefs = selectedBookingRefs();
    const loadId = ++rescheduleOptionsSequence;
    selectedRescheduleOption = null;
    renderRescheduleComparison();
    if (!date || !itemRefs.length) {
      renderSlotOptions([], itemRefs.length ? "Choose a preferred date to see exact available times." : "Select at least one booked schedule first.");
      return;
    }
    if (typeof window.DB?.getBookingRescheduleOptions !== "function") {
      renderSlotOptions([], "Schedule availability is temporarily unavailable. Please try again shortly.");
      return;
    }
    renderSlotOptions([], "Checking live court availability…", true);
    try {
      const response = await window.DB.getBookingRescheduleOptions(
        bookingContext.reference,
        bookingContext.email,
        itemRefs,
        date,
      );
      if (loadId !== rescheduleOptionsSequence || rescheduleDialog.hidden) return;
      const rawOptions = Array.isArray(response) ? response : (Array.isArray(response?.options) ? response.options : []);
      rescheduleOptions = rawOptions.map(normalizeRescheduleOption);
      const slotGrid = rescheduleContent.querySelector("#rescheduleSlotGrid");
      const restoreSlots = String(slotGrid?.dataset.restoreSlots || "");
      if (restoreSlots) {
        selectedRescheduleOption = rescheduleOptions.find((option) => (
          option.available
          && !isCurrentScheduleOption(option, date)
          && option.slots.join(",") === restoreSlots
        )) || null;
        delete slotGrid.dataset.restoreSlots;
      }
      renderSlotOptions(rescheduleOptions);
      renderRescheduleComparison();
    } catch (_) {
      if (loadId === rescheduleOptionsSequence) {
        renderSlotOptions([], "We couldn’t load availability right now. Please try another date or try again shortly.");
      }
    }
  }

  function makeRescheduleSection(step, title, help) {
    const section = element("section", "reschedule-section");
    const heading = element("div", "reschedule-section-heading");
    const copy = element("div");
    copy.append(element("span", "reschedule-step", step), element("h3", "", title));
    if (help) copy.append(element("p", "reschedule-section-help", help));
    heading.append(copy);
    section.append(heading);
    return section;
  }

  function friendlyRescheduleError(error, fallback) {
    const code = String(error?.code || "").toLowerCase();
    const message = String(error?.message || "").toLowerCase();
    if (code === "too_many_requests" || message.includes("wait 15 seconds") || message.includes("too many request")) {
      return "Please wait 15 seconds before sending another schedule request.";
    }
    if (code.includes("token") || message.includes("access token") || message.includes("secure booking access")) {
      return "Secure booking access has expired. Refresh this page and find your booking again.";
    }
    if (message.includes("already has") || message.includes("already pending")) {
      return "This booking already has a pending schedule request. Refresh the booking to review it.";
    }
    if (message.includes("no longer available") || message.includes("slot") && message.includes("available")) {
      return "That time is no longer available. Choose another live option and try again.";
    }
    if (message.includes("eligible") || message.includes("cutoff") || message.includes("too late")) {
      return "This booking is not currently eligible for an online schedule change. Contact Pickle Street for help.";
    }
    return fallback;
  }

  function mergeRescheduleStateResponse(response) {
    if (!response || typeof response !== "object") return null;
    if (response.booking || !rescheduleState?.booking) return response;
    return { ...response, booking: rescheduleState.booking };
  }

  function makeBookingSelection(rows, selectedRefs, disabled) {
    const list = element("ul", "reschedule-selection-list");
    rows.forEach((row, index) => {
      const item = element("li");
      const label = element("label", "reschedule-booking-option");
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.name = "rescheduleItem";
      checkbox.value = String(row.ref || "");
      checkbox.checked = selectedRefs.has(normalizeReference(row.ref));
      checkbox.disabled = disabled;
      checkbox.setAttribute("aria-label", `Change ${row.courtName || `schedule ${index + 1}`}, ${formatDate(row.date)}, ${formatTimeRange(row)}`);
      label.append(
        checkbox,
        element("strong", "reschedule-booking-court", String(row.courtName || "Court")),
        element("span", "reschedule-booking-date", formatDate(row.date)),
        element("span", "reschedule-booking-time", formatTimeRange(row)),
      );
      checkbox.addEventListener("change", () => {
        const grid = rescheduleContent.querySelector("#rescheduleSlotGrid");
        if (grid) delete grid.dataset.restoreSlots;
        rescheduleFeedback.textContent = "";
        void loadRescheduleOptions();
      });
      item.append(label);
      list.append(item);
    });
    return list;
  }

  function renderOwnerReschedulePreview() {
    const choose = makeRescheduleSection("Step 1", "Select booked schedules", "Grouped bookings can be reviewed item by item. Guest changes remain subject to eligibility and live availability.");
    choose.append(makeBookingSelection(bookingContext.rows, new Set(bookingContext.rows.map((row) => normalizeReference(row.ref))), true));

    const comparison = makeRescheduleSection("Preview", "Current → requested schedule", "No booking data can be changed from owner preview.");
    const compare = element("div", "reschedule-comparison");
    const current = selectedScheduleSummary(bookingContext.rows);
    const oldCard = element("div", "reschedule-comparison-card");
    oldCard.append(element("span", "reschedule-comparison-label", "Current schedule"), element("strong", "", current.title), element("span", "", current.detail));
    const arrow = element("span", "reschedule-comparison-arrow", "→");
    arrow.setAttribute("aria-hidden", "true");
    const newCard = element("div", "reschedule-comparison-card is-new");
    newCard.append(element("span", "reschedule-comparison-label", "Requested schedule"), element("strong", "", "Guest selects a new date and time"), element("span", "", "A pending request is sent to the system for review."));
    compare.append(oldCard, arrow, newCard);
    comparison.append(compare);
    const adminLink = element("a", "reschedule-admin-link", "Open Admin Dashboard →");
    adminLink.href = "admin.html#bookings";
    comparison.append(adminLink);
    rescheduleContent.replaceChildren(choose, comparison);
    rescheduleSubmit.hidden = true;
    document.getElementById("rescheduleCancel").textContent = "Done";
  }

  function renderReadOnlyRequest(request, allowWithdraw = false) {
    const statusSection = makeRescheduleSection("Request status", "Schedule change details");
    statusSection.append(makeRescheduleStatusCard(request, true));
    const comparison = makeRescheduleSection("Schedule", "Current → requested");
    const compare = element("div", "reschedule-comparison");
    compare.id = "rescheduleComparison";
    const selectedRefs = new Set(requestItemRefs(request));
    const oldSchedule = requestField(request, "oldSchedule", "old_schedule");
    const requestedSchedule = requestField(request, "requestedSchedule", "requested_schedule");
    const fallbackRows = selectedRefs.size
      ? bookingContext.rows.filter((row) => selectedRefs.has(normalizeReference(row.ref)))
      : bookingContext.rows;
    const oldRows = Array.isArray(oldSchedule?.items) && oldSchedule.items.length ? oldSchedule.items : fallbackRows;
    const requestedRows = Array.isArray(requestedSchedule?.items) && requestedSchedule.items.length ? requestedSchedule.items : fallbackRows;
    const current = selectedScheduleSummary(oldRows);
    const requested = selectedScheduleSummary(requestedRows);
    const oldCard = element("div", "reschedule-comparison-card");
    oldCard.append(element("span", "reschedule-comparison-label", "Previous schedule"), element("strong", "", current.title), element("span", "", current.detail));
    const arrow = element("span", "reschedule-comparison-arrow", "→");
    arrow.setAttribute("aria-hidden", "true");
    const next = element("div", "reschedule-comparison-card is-new");
    next.append(element("span", "reschedule-comparison-label", "Requested schedule"), element("strong", "", requested.title), element("span", "", requestScheduleSummary(request)));
    compare.append(oldCard, arrow, next);
    comparison.append(compare);
    if (allowWithdraw) {
      const withdraw = element("button", "reschedule-withdraw", "Withdraw this request");
      withdraw.type = "button";
      withdraw.addEventListener("click", () => void withdrawRescheduleRequest(withdraw, request));
      comparison.append(withdraw);
    }
    rescheduleContent.replaceChildren(statusSection, comparison);
    rescheduleSubmit.hidden = true;
    document.getElementById("rescheduleCancel").textContent = "Done";
  }

  function renderRescheduleEditor() {
    rescheduleFeedback.classList.remove("is-success");
    rescheduleFeedback.textContent = "";
    rescheduleSubmit.hidden = false;
    rescheduleSubmit.disabled = false;
    document.getElementById("rescheduleCancel").textContent = "Not now";
    selectedRescheduleOption = null;
    rescheduleOptions = [];

    if (ownerPreviewActive) {
      renderOwnerReschedulePreview();
      return;
    }

    const request = activeRequestFromState(rescheduleState);
    const status = request ? requestStatus(request) : "";
    if (request && status === "approved") {
      renderReadOnlyRequest(request);
      return;
    }
    const eligibility = rescheduleEligibility();
    if (request && eligibility.known && !eligibility.eligible) {
      renderReadOnlyRequest(request, status === "pending");
      return;
    }

    const selectedRefs = new Set(request && status === "pending" && requestItemRefs(request).length
      ? requestItemRefs(request)
      : bookingContext.rows.map((row) => normalizeReference(row.ref)));
    if (request && status === "pending") {
      const existing = makeRescheduleSection("Pending review", "Update or withdraw your request", "Submitting again replaces the requested schedule; your current booking stays confirmed until approval.");
      existing.append(makeRescheduleStatusCard(request, true));
      rescheduleContent.replaceChildren(existing);
    } else {
      rescheduleContent.replaceChildren();
    }

    const choose = makeRescheduleSection("Step 1", bookingContext.rows.length > 1 ? "Which schedules should change?" : "Current booked schedule", bookingContext.rows.length > 1 ? "Select every court schedule you want moved together." : "This schedule will remain confirmed until your request is approved.");
    choose.append(makeBookingSelection(bookingContext.rows, selectedRefs, false));
    rescheduleContent.append(choose);

    const availability = makeRescheduleSection("Step 2", "Choose an exact available time", "Only same-duration options that fit the selected court schedule are shown.");
    const dateWrap = element("div", "reschedule-date-wrap");
    const dateField = element("div", "reschedule-field");
    const dateLabel = element("label", "", "Preferred date");
    dateLabel.htmlFor = "rescheduleDate";
    const dateInput = document.createElement("input");
    dateInput.type = "date";
    dateInput.id = "rescheduleDate";
    dateInput.name = "requestedDate";
    dateInput.min = minimumRescheduleDate();
    dateInput.max = addDays(todayInManila(), 366);
    dateInput.required = true;
    const restoredDate = request && status === "pending" ? requestDate(request) : "";
    dateInput.value = restoredDate >= dateInput.min && restoredDate <= dateInput.max ? restoredDate : "";
    dateInput.addEventListener("change", () => {
      const grid = rescheduleContent.querySelector("#rescheduleSlotGrid");
      if (grid) delete grid.dataset.restoreSlots;
      rescheduleFeedback.textContent = "";
      void loadRescheduleOptions();
    });
    dateField.append(dateLabel, dateInput);
    dateWrap.append(dateField, element("div", "reschedule-availability-hint", "Availability is checked live. A requested time is not held until Pickle Street approves it."));
    availability.append(dateWrap);
    const slotGrid = element("div", "reschedule-slot-grid");
    slotGrid.id = "rescheduleSlotGrid";
    slotGrid.setAttribute("aria-label", "Available time slots");
    slotGrid.setAttribute("aria-busy", "false");
    if (request && status === "pending" && requestSlots(request).length) {
      slotGrid.dataset.restoreSlots = requestSlots(request).join(",");
    }
    const availabilityStatus = element("p", "reschedule-availability-status", dateInput.value ? "Checking live court availability…" : "Choose a preferred date to see exact available times.");
    availabilityStatus.id = "rescheduleAvailabilityStatus";
    availabilityStatus.setAttribute("role", "status");
    availabilityStatus.setAttribute("aria-live", "polite");
    availabilityStatus.setAttribute("aria-atomic", "true");
    availability.append(availabilityStatus, slotGrid);
    rescheduleContent.append(availability);

    const review = makeRescheduleSection("Step 3", "Review your request", "Check the before-and-after schedule before sending.");
    const comparison = element("div", "reschedule-comparison");
    comparison.id = "rescheduleComparison";
    review.append(comparison);
    const noteField = element("div", "reschedule-field");
    const noteLabel = element("label", "", "Note for Pickle Street (optional)");
    noteLabel.htmlFor = "rescheduleNote";
    const note = document.createElement("textarea");
    note.id = "rescheduleNote";
    note.name = "note";
    note.maxLength = 500;
    note.rows = 3;
    note.placeholder = "Add a short reason or anything our team should know.";
    if (request && status === "pending") note.value = String(requestField(request, "note", "note") || "");
    noteField.append(noteLabel, note);
    review.append(noteField);
    const acknowledge = element("label", "reschedule-ack");
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.id = "rescheduleAcknowledge";
    checkbox.required = true;
    acknowledge.append(checkbox, element("span", "", "I understand that payments are final and non-refundable, and that this requested schedule is not reserved until Pickle Street approves it."));
    review.append(acknowledge);

    if (request && status === "pending") {
      const withdraw = element("button", "reschedule-withdraw", "Withdraw this request");
      withdraw.type = "button";
      withdraw.addEventListener("click", () => void withdrawRescheduleRequest(withdraw, request));
      review.append(withdraw);
      rescheduleSubmit.firstChild.textContent = "Update request ";
    } else {
      rescheduleSubmit.firstChild.textContent = "Send request ";
    }
    rescheduleContent.append(review);
    renderRescheduleComparison();
    renderSlotOptions([], dateInput.value ? "Checking live court availability…" : "Choose a preferred date to see exact available times.", Boolean(dateInput.value));
    if (dateInput.value) void loadRescheduleOptions();
  }

  function setRescheduleMutationBusy(isBusy) {
    rescheduleMutationBusy = Boolean(isBusy);
    rescheduleForm?.setAttribute("aria-busy", String(rescheduleMutationBusy));
    ["rescheduleClose", "rescheduleCancel", "rescheduleBackdrop"].forEach((id) => {
      const control = document.getElementById(id);
      if (control) control.disabled = rescheduleMutationBusy;
    });
  }

  function setRescheduleDialogOpen(open, trigger) {
    if (!rescheduleDialog || !rescheduleSheet) return;
    if (open) {
      if (rescheduleCloseTimer) window.clearTimeout(rescheduleCloseTimer);
      rescheduleCloseTimer = 0;
      rescheduleRestoreFocus = trigger || document.activeElement;
      rescheduleDialog.hidden = false;
      document.body.classList.add("has-reschedule-dialog");
      [...document.body.children].filter((node) => node !== rescheduleDialog).forEach((node) => { node.inert = true; });
      window.requestAnimationFrame(() => document.getElementById("rescheduleClose")?.focus());
      return;
    }
    rescheduleDialog.hidden = true;
    document.body.classList.remove("has-reschedule-dialog");
    [...document.body.children].filter((node) => node !== rescheduleDialog).forEach((node) => { node.inert = false; });
    const focusTarget = rescheduleRestoreFocus;
    rescheduleRestoreFocus = null;
    if (focusTarget && document.contains(focusTarget)) window.requestAnimationFrame(() => focusTarget.focus());
  }

  async function openRescheduleDialog(trigger) {
    if (!bookingContext) return;
    if (!ownerPreviewActive && !rescheduleStateReady) {
      const mount = document.getElementById("rescheduleStatusMount");
      await (rescheduleStatePromise || refreshRescheduleState(mount));
    }
    if (!ownerPreviewActive && rescheduleStateError) {
      applyReschedulePolicyState();
      rescheduleRequestButton?.focus();
      return;
    }
    const request = activeRequestFromState(rescheduleState);
    const eligibility = rescheduleEligibility();
    if (!ownerPreviewActive && !request && eligibility.known && !eligibility.eligible) {
      applyReschedulePolicyState();
      rescheduleRequestButton?.focus();
      return;
    }
    rescheduleOwnerNotice.hidden = !ownerPreviewActive;
    setRescheduleMutationBusy(false);
    renderRescheduleEditor();
    setRescheduleDialogOpen(true, trigger);
  }

  function closeRescheduleDialog() {
    if (rescheduleDialog?.hidden) return;
    if (rescheduleMutationBusy) {
      rescheduleFeedback.textContent = "Please wait while your schedule request is being saved.";
      return;
    }
    if (rescheduleCloseTimer) window.clearTimeout(rescheduleCloseTimer);
    rescheduleCloseTimer = 0;
    rescheduleOptionsSequence += 1;
    setRescheduleDialogOpen(false);
  }

  function trapRescheduleFocus(event) {
    if (rescheduleDialog?.hidden) return;
    if (event.key === "Escape") {
      event.preventDefault();
      closeRescheduleDialog();
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = [...rescheduleSheet.querySelectorAll('a[href], button:not([disabled]):not([hidden]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])')]
      .filter((node) => !node.hidden && node.getClientRects().length);
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  async function submitRescheduleRequest(event) {
    event.preventDefault();
    if (!bookingContext || ownerPreviewActive) return;
    const itemRefs = selectedBookingRefs();
    const requestedDateInput = rescheduleContent.querySelector("#rescheduleDate");
    const requestedDate = requestedDateInput?.value || "";
    const note = String(rescheduleContent.querySelector("#rescheduleNote")?.value || "").trim();
    const acknowledged = Boolean(rescheduleContent.querySelector("#rescheduleAcknowledge")?.checked);
    rescheduleFeedback.classList.remove("is-success");

    if (!itemRefs.length) {
      rescheduleFeedback.textContent = "Select at least one booked schedule to change.";
      rescheduleContent.querySelector('input[name="rescheduleItem"]')?.focus();
      return;
    }
    if (!requestedDate) {
      rescheduleFeedback.textContent = "Choose your preferred date.";
      requestedDateInput?.focus();
      return;
    }
    if ((requestedDateInput?.min && requestedDate < requestedDateInput.min)
        || (requestedDateInput?.max && requestedDate > requestedDateInput.max)) {
      rescheduleFeedback.textContent = `Choose a date from ${formatDate(requestedDateInput.min)} through ${formatDate(requestedDateInput.max)}.`;
      requestedDateInput?.focus();
      return;
    }
    if (!selectedRescheduleOption) {
      rescheduleFeedback.textContent = "Choose one available time for the requested date.";
      rescheduleContent.querySelector(".reschedule-slot")?.focus();
      return;
    }
    if (!acknowledged) {
      rescheduleFeedback.textContent = "Please confirm the payment and availability notice before sending.";
      rescheduleContent.querySelector("#rescheduleAcknowledge")?.focus();
      return;
    }
    if (typeof window.DB?.submitBookingRescheduleRequest !== "function") {
      rescheduleFeedback.textContent = "Reschedule requests are temporarily unavailable. Please try again shortly.";
      return;
    }

    setRescheduleMutationBusy(true);
    rescheduleSubmit.disabled = true;
    rescheduleSubmit.setAttribute("aria-busy", "true");
    rescheduleSubmit.firstChild.textContent = "Sending… ";
    try {
      const response = await window.DB.submitBookingRescheduleRequest({
        bookingRef: bookingContext.reference,
        email: bookingContext.email,
        itemRefs,
        requestedDate,
        requestedSlots: selectedRescheduleOption.slots,
        note,
        acknowledgedNoRefund: true,
        acknowledgedSlotNotHeld: true,
      });
      rescheduleState = mergeRescheduleStateResponse(response);
      const request = activeRequestFromState(rescheduleState);
      const mount = document.getElementById("rescheduleStatusMount");
      if (mount && request) mount.replaceChildren(makeRescheduleStatusCard(request));
      applyReschedulePolicyState();
      rescheduleFeedback.classList.add("is-success");
      rescheduleFeedback.textContent = "Request sent. Your original schedule remains confirmed while it is reviewed.";
      setRescheduleMutationBusy(false);
      rescheduleCloseTimer = window.setTimeout(closeRescheduleDialog, 650);
    } catch (error) {
      setRescheduleMutationBusy(false);
      rescheduleFeedback.textContent = friendlyRescheduleError(error, "We couldn’t send this request. Recheck the schedule and try again.");
      rescheduleSubmit.disabled = false;
      rescheduleSubmit.setAttribute("aria-busy", "false");
      rescheduleSubmit.firstChild.textContent = activeRequestFromState(rescheduleState) ? "Update request " : "Send request ";
    }
  }

  async function withdrawRescheduleRequest(button, request) {
    if (button.dataset.confirming !== "true") {
      button.dataset.confirming = "true";
      button.textContent = "Confirm withdrawal";
      rescheduleFeedback.textContent = "This only withdraws the request. Your current booking stays unchanged.";
      button.focus();
      return;
    }
    if (typeof window.DB?.withdrawBookingRescheduleRequest !== "function") {
      rescheduleFeedback.textContent = "This request cannot be withdrawn right now. Please try again shortly.";
      return;
    }
    setRescheduleMutationBusy(true);
    button.disabled = true;
    button.textContent = "Withdrawing…";
    try {
      const requestId = String(requestField(request, "id", "id") || requestField(request, "requestId", "request_id") || "");
      const response = await window.DB.withdrawBookingRescheduleRequest({
        bookingRef: bookingContext.reference,
        email: bookingContext.email,
        requestId,
      });
      rescheduleState = mergeRescheduleStateResponse(response);
      const updated = activeRequestFromState(rescheduleState);
      const mount = document.getElementById("rescheduleStatusMount");
      if (mount && updated) mount.replaceChildren(makeRescheduleStatusCard(updated));
      setRescheduleMutationBusy(false);
      applyReschedulePolicyState();
      closeRescheduleDialog();
    } catch (error) {
      setRescheduleMutationBusy(false);
      button.disabled = false;
      button.dataset.confirming = "false";
      button.textContent = "Withdraw this request";
      rescheduleFeedback.textContent = friendlyRescheduleError(error, "We couldn’t withdraw this request. Please try again.");
    }
  }

  function renderBooking(rows, requestedReference, wasLimited) {
    const bookingMeta = aggregateBookingStatus(rows);
    const paymentMeta = aggregatePaymentStatus(rows);
    const reference = displayReference(rows, requestedReference);
    const total = rows.reduce((sum, row) => sum + safeNumber(row.total), 0);
    const paymentMethods = naturalList(rows.map((row) => paymentMethodLabel(row.paymentMethod)));
    const isInactive = rows.every((row) => ["cancelled", "forfeited", "completed"].includes(String(row.status || "").toLowerCase()));
    const isOwnerResult = ownerPreviewActive || rows.some((row) => row.managementAccess === "owner_preview");
    bookingContext = {
      rows: rows.slice(),
      reference,
      email: String(emailInput.value || "").trim().toLowerCase(),
    };
    rescheduleState = null;
    rescheduleStatePromise = null;
    rescheduleStateReady = false;
    rescheduleStateError = null;
    rescheduleRequestButton = null;
    reschedulePolicyHeading = null;
    reschedulePolicyCopy = null;
    reschedulePolicyContact = null;
    rescheduleStateSequence += 1;
    rescheduleOptionsSequence += 1;

    const root = element("div", "booking-result");
    const header = element("div", "result-header");
    const identity = element("div");
    identity.append(
      element("p", "result-overline", rows.length > 1 ? `${rows.length} booking items` : "Booking details"),
      element("h2", "", rows.length > 1 ? "Your booking group" : "Your booking"),
      element("p", "booking-reference", reference),
    );
    const statuses = element("div", "status-stack");
    statuses.append(makeStatusPill(bookingMeta, "Booking"), makeStatusPill(paymentMeta, "Payment"));
    header.append(identity, statuses);
    root.append(header, element("p", "status-message", bookingMeta.message));

    const summary = element("div", "summary-grid");
    summary.setAttribute("aria-label", "Booking payment summary");
    summary.append(
      makeSummaryItem("Booking total", formatCurrency(total)),
      makeSummaryItem("Payment method", paymentMethods),
      makeSummaryItem("Payment summary", paymentSummary(rows, paymentMeta)),
    );
    root.append(summary);

    const scheduleSection = element("section", "schedule-section");
    scheduleSection.append(element("h3", "", rows.length > 1 ? "Booked schedules" : "Booked schedule"));
    const scheduleList = element("ul", "schedule-list");
    rows
      .slice()
      .sort((left, right) => scheduleSortKey(left).localeCompare(scheduleSortKey(right)))
      .forEach((row) => scheduleList.append(makeScheduleItem(row)));
    scheduleSection.append(scheduleList);
    root.append(scheduleSection);

    if (wasLimited) {
      root.append(element("p", "status-message", `Showing the first ${MAX_RESULT_ROWS} schedule items. Contact Pickle Street for help with the complete booking group.`));
    }

    const rescheduleStatusMount = element("div", "reschedule-status-mount");
    rescheduleStatusMount.id = "rescheduleStatusMount";
    root.append(rescheduleStatusMount);

    const policy = element("section", "booking-policy");
    if (isInactive) {
      policy.append(
        element("h3", "", "Need help with this booking?"),
        element("p", "", "Paid booking payments are final and non-refundable. This page is view-only; contact Pickle Street if the status shown does not match your records."),
        makeContactButton(reference, "Contact Pickle Street", "Booking status help", "reschedule-button"),
      );
    } else {
      const requestButton = element(
        "button",
        "reschedule-button",
        isOwnerResult ? "Preview reschedule flow" : "Request a schedule change",
      );
      requestButton.type = "button";
      requestButton.disabled = !isOwnerResult;
      if (!isOwnerResult) requestButton.setAttribute("aria-busy", "true");
      requestButton.addEventListener("click", (event) => void openRescheduleDialog(event.currentTarget));
      const policyHeading = element("h3", "", isOwnerResult ? "Preview the guest reschedule experience" : "Need to change your schedule?");
      const policyCopy = element("p", "", isOwnerResult
        ? "Owner preview is read-only. Guest submissions and owner decisions remain separate and securely verified."
        : "Securely checking your booking’s schedule-change options.");
      const policyContact = makeContactButton(reference, "Contact Pickle Street", "Schedule change help", "contact-button");
      policyContact.hidden = true;
      policy.append(
        policyHeading,
        policyCopy,
        requestButton,
        policyContact,
      );
      rescheduleRequestButton = requestButton;
      reschedulePolicyHeading = policyHeading;
      reschedulePolicyCopy = policyCopy;
      reschedulePolicyContact = policyContact;
    }
    root.append(policy);

    if (ownerResultNote) {
      ownerResultNote.hidden = !rows.some((row) => row.managementAccess === "owner_preview");
    }
    resultRegion.replaceChildren(root);
    applyReschedulePolicyState();
    if (!isInactive && !isOwnerResult) void refreshRescheduleState(rescheduleStatusMount);
    focusResult();
  }

  function renderEmptyState() {
    bookingContext = null;
    rescheduleState = null;
    rescheduleStateSequence += 1;
    rescheduleOptionsSequence += 1;
    if (ownerResultNote) ownerResultNote.hidden = true;
    const empty = element("div", "empty-state");
    const icon = element("div", "empty-icon");
    icon.setAttribute("aria-hidden", "true");
    icon.innerHTML = '<svg viewBox="0 0 48 48" role="img"><circle cx="21" cy="21" r="10"></circle><path d="m29 29 9 9"></path><path d="M17 21h8M21 17v8"></path></svg>';
    empty.append(
      icon,
      element("h2", "", "Your booking details will appear here"),
      element("p", "", "Once found, you can view the schedule, payment status, and available support options."),
    );
    resultRegion.replaceChildren(empty);
  }

  function setOwnerPreviewUrl(enabled) {
    const url = new URL(window.location.href);
    const fragment = new URLSearchParams(url.hash.replace(/^#/, ""));
    const reference = normalizeReference(refInput?.value);
    if (referenceLooksValid(reference)) fragment.set("ref", reference);
    else fragment.delete("ref");
    if (enabled) fragment.set("ownerPreview", "1");
    else fragment.delete("ownerPreview");
    const hash = fragment.toString();
    window.history.replaceState(null, "", `${url.pathname}${url.search}${hash ? `#${hash}` : ""}`);
  }

  function setOwnerPreviewMode(enabled, updateUrl = true) {
    ownerPreviewActive = Boolean(enabled);
    document.body.classList.toggle("owner-preview-active", ownerPreviewActive);
    ownerPreviewModeButton?.classList.toggle("is-active", ownerPreviewActive);
    ownerPreviewModeButton?.setAttribute("aria-pressed", String(ownerPreviewActive));
    guestAccessModeButton?.classList.toggle("is-active", !ownerPreviewActive);
    guestAccessModeButton?.setAttribute("aria-pressed", String(!ownerPreviewActive));
    if (lookupButton) lookupButton.querySelector(".button-label").textContent = idleLookupLabel();
    if (ownerResultNote) ownerResultNote.hidden = true;
    if (updateUrl) setOwnerPreviewUrl(ownerPreviewActive);
  }

  function continueAsGuest() {
    ownerPreviewRequested = false;
    setOwnerPreviewMode(false);
    renderEmptyState();
    refInput?.focus();
  }

  function makeContinueAsGuestButton() {
    const button = element("button", "owner-state-action", "Continue as guest");
    button.type = "button";
    button.addEventListener("click", continueAsGuest);
    return button;
  }

  async function configureOwnerPreview() {
    if (!ownerPreviewRequested) return;
    lookupButton.disabled = true;
    lookupButton.setAttribute("aria-busy", "true");
    try {
      const context = typeof window.DB?.getBookingManagementViewerContext === "function"
        ? await window.DB.getBookingManagementViewerContext()
        : { isAuthenticated: false, isSystemOwner: false };

      if (!context?.isSystemOwner) {
        setOwnerPreviewMode(false, false);
        renderMessageState({
          tone: "warning",
          title: "Owner preview isn’t available in this browser",
          message: "Sign in to the Admin Dashboard in this browser, then open Preview guest view again. Normal guest access remains protected by the original booking device.",
          actions: [makeOwnerSignInButton(), makeContinueAsGuestButton()],
        });
        return;
      }

      ownerPreviewBanner.hidden = false;
      setOwnerPreviewMode(true, false);
    } catch (_) {
      setOwnerPreviewMode(false, false);
      renderMessageState({
        tone: "warning",
        title: "Owner session could not be verified",
        message: "Sign in to the Admin Dashboard in this browser, then try the owner preview again.",
        actions: [makeOwnerSignInButton(), makeContinueAsGuestButton()],
      });
    } finally {
      lookupButton.disabled = false;
      lookupButton.setAttribute("aria-busy", "false");
      lookupButton.querySelector(".button-label").textContent = idleLookupLabel();
    }
  }

  function prefillReference() {
    const url = new URL(window.location.href);
    const fragment = new URLSearchParams(url.hash.replace(/^#/, ""));
    ownerPreviewRequested = fragment.get("ownerPreview") === "1";
    const rawReference = fragment.get("ref") || url.searchParams.get("ref") || "";
    const reference = normalizeReference(rawReference);
    if (referenceLooksValid(reference)) refInput.value = reference;

    let removedPrivateParameter = false;
    ["email", "bookingEmail", "booking_email"].forEach((key) => {
      if (url.searchParams.has(key)) {
        url.searchParams.delete(key);
        removedPrivateParameter = true;
      }
    });
    if (removedPrivateParameter) {
      window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
    }
  }

  async function submitLookup(event) {
    event.preventDefault();
    clearValidation();

    const reference = normalizeReference(refInput.value);
    const email = String(emailInput.value || "").trim().toLowerCase();
    refInput.value = reference;

    if (!referenceLooksValid(reference)) {
      validationError(refInput, "Enter a Pickle Street booking reference that starts with PB-.");
      return;
    }
    if (!emailLooksValid(email)) {
      validationError(emailInput, "Enter the valid booking email used at checkout.");
      return;
    }

    setLoading(true);
    renderLoadingState();

    try {
      if (!window.DB || typeof window.DB.getBookingForManagement !== "function") {
        const unavailable = new Error("Booking lookup is unavailable.");
        unavailable.code = "BOOKING_LOOKUP_UNAVAILABLE";
        throw unavailable;
      }

      const response = await window.DB.getBookingForManagement(reference, email, {
        ownerPreview: ownerPreviewActive,
      });
      const allRows = Array.isArray(response) ? response.filter((row) => row && typeof row === "object") : [];
      if (!allRows.length) {
        renderMessageState({
          title: "We couldn’t find that booking",
          message: "We couldn’t find a booking matching those details. Check the booking reference and booking email, then try again.",
          reference,
        });
        return;
      }

      renderBooking(allRows.slice(0, MAX_RESULT_ROWS), reference, allRows.length > MAX_RESULT_ROWS);
    } catch (error) {
      if (String(error?.code || "") === "BOOKING_ACCESS_TOKEN_MISSING") {
        renderMessageState({
          tone: "warning",
          title: "Open this on the original browser or device",
          message: "For privacy, this booking can only be viewed in the browser and device used to complete checkout. If you changed device, changed browser, or cleared browser data, contact Pickle Street and include your PB booking reference.",
          contact: true,
          reference,
          actions: [makeOwnerSignInButton("System owner? Sign in to preview")],
        });
        return;
      }

      if (["OWNER_PREVIEW_UNAUTHORIZED", "42501"].includes(String(error?.code || ""))) {
        setOwnerPreviewMode(false, false);
        renderMessageState({
          tone: "warning",
          title: "Your System Owner session has expired",
          message: "Sign in to the Admin Dashboard in this browser, then reopen the owner preview.",
          actions: [makeOwnerSignInButton(), makeContinueAsGuestButton()],
        });
        return;
      }

      renderMessageState({
        title: "Booking lookup is temporarily unavailable",
        message: "We couldn’t securely check your booking right now. Please try again in a moment or contact Pickle Street if you still need help.",
        contact: true,
        reference,
      });
    } finally {
      setLoading(false);
    }
  }

  function init() {
    form = document.getElementById("bookingLookupForm");
    refInput = document.getElementById("bookingRef");
    emailInput = document.getElementById("bookingEmail");
    lookupButton = document.getElementById("lookupButton");
    resultRegion = document.getElementById("bookingResult");
    formFeedback = document.getElementById("formFeedback");
    ownerPreviewBanner = document.getElementById("ownerPreviewBanner");
    ownerPreviewModeButton = document.getElementById("ownerPreviewModeButton");
    guestAccessModeButton = document.getElementById("guestAccessModeButton");
    ownerResultNote = document.getElementById("ownerResultNote");
    rescheduleDialog = document.getElementById("rescheduleDialog");
    rescheduleSheet = document.getElementById("rescheduleSheet");
    rescheduleForm = document.getElementById("rescheduleForm");
    rescheduleContent = document.getElementById("rescheduleContent");
    rescheduleFeedback = document.getElementById("rescheduleFeedback");
    rescheduleSubmit = document.getElementById("rescheduleSubmit");
    rescheduleOwnerNotice = document.getElementById("rescheduleOwnerNotice");
    if (!form || !refInput || !emailInput || !lookupButton || !resultRegion || !formFeedback) return;

    prefillReference();
    ownerPreviewModeButton?.addEventListener("click", () => {
      setOwnerPreviewMode(true);
      renderEmptyState();
    });
    guestAccessModeButton?.addEventListener("click", continueAsGuest);
    form.addEventListener("submit", submitLookup);
    rescheduleForm?.addEventListener("submit", submitRescheduleRequest);
    document.getElementById("rescheduleClose")?.addEventListener("click", closeRescheduleDialog);
    document.getElementById("rescheduleCancel")?.addEventListener("click", closeRescheduleDialog);
    document.getElementById("rescheduleBackdrop")?.addEventListener("click", closeRescheduleDialog);
    rescheduleDialog?.addEventListener("keydown", trapRescheduleFocus);
    refInput.addEventListener("input", () => {
      refInput.setAttribute("aria-invalid", "false");
      formFeedback.textContent = "";
    });
    refInput.addEventListener("blur", () => {
      refInput.value = normalizeReference(refInput.value);
    });
    emailInput.addEventListener("input", () => {
      emailInput.setAttribute("aria-invalid", "false");
      formFeedback.textContent = "";
    });
    void configureOwnerPreview();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }
})();

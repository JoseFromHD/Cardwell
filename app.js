const themeKey = "cardwell:theme";

let currentUser = null;
let state = { decks: [] };
let users = [];
let activeDeckId = null;
let editingCardId = null;
let currentStudyCardId = null;
let showingAnswer = false;

const authShell = document.querySelector("#authShell");
const appShell = document.querySelector("#appShell");
const loginForm = document.querySelector("#loginForm");
const loginUsername = document.querySelector("#loginUsername");
const loginPassword = document.querySelector("#loginPassword");
const loginMessage = document.querySelector("#loginMessage");
const currentUserLabel = document.querySelector("#currentUserLabel");
const themeToggleButton = document.querySelector("#themeToggleButton");
const logoutButton = document.querySelector("#logoutButton");
const deckList = document.querySelector("#deckList");
const deckTitle = document.querySelector("#deckTitle");
const collectionSummary = document.querySelector("#collectionSummary");
const statCards = document.querySelector("#statCards");
const statDue = document.querySelector("#statDue");
const statMastered = document.querySelector("#statMastered");
const studyLabel = document.querySelector("#studyLabel");
const studyText = document.querySelector("#studyText");
const flipButton = document.querySelector("#flipButton");
const ratingActions = document.querySelector("#ratingActions");
const cardForm = document.querySelector("#cardForm");
const frontInput = document.querySelector("#frontInput");
const backInput = document.querySelector("#backInput");
const formTitle = document.querySelector("#formTitle");
const saveCardButton = document.querySelector("#saveCardButton");
const cancelEditButton = document.querySelector("#cancelEditButton");
const cardList = document.querySelector("#cardList");
const searchInput = document.querySelector("#searchInput");
const accessPanel = document.querySelector("#accessPanel");
const accessForm = document.querySelector("#accessForm");
const shareUsernameInput = document.querySelector("#shareUsernameInput");
const shareRoleInput = document.querySelector("#shareRoleInput");
const accessList = document.querySelector("#accessList");
const deckRoleLabel = document.querySelector("#deckRoleLabel");
const userPanel = document.querySelector("#userPanel");
const userForm = document.querySelector("#userForm");
const newUsernameInput = document.querySelector("#newUsernameInput");
const newPasswordInput = document.querySelector("#newPasswordInput");
const newUserAdminInput = document.querySelector("#newUserAdminInput");
const userList = document.querySelector("#userList");

document.querySelector("#newDeckButton").addEventListener("click", createDeck);
document.querySelector("#renameDeckButton").addEventListener("click", renameDeck);
document.querySelector("#deleteDeckButton").addEventListener("click", deleteDeck);
document.querySelector("#exportButton").addEventListener("click", exportBackup);
document.querySelector("#importInput").addEventListener("change", importBackup);
loginForm.addEventListener("submit", login);
logoutButton.addEventListener("click", logout);
themeToggleButton.addEventListener("click", toggleTheme);
flipButton.addEventListener("click", flipStudyCard);
ratingActions.addEventListener("click", rateCard);
cardForm.addEventListener("submit", saveCard);
cancelEditButton.addEventListener("click", resetForm);
searchInput.addEventListener("input", renderCards);
accessForm.addEventListener("submit", shareDeck);
userForm.addEventListener("submit", createUser);

applyTheme(localStorage.getItem(themeKey) ?? "light");
bootstrap();

async function api(path, options = {}) {
  const headers = { ...(options.headers ?? {}) };
  const method = (options.method ?? "GET").toUpperCase();
  if (options.body && !(options.body instanceof FormData)) {
    headers["Content-Type"] = "application/json";
  }
  if (method !== "GET") {
    headers["X-Cardwell-CSRF"] = "1";
  }

  const response = await fetch(path, { ...options, headers });
  if (response.status === 401 && path !== "/api/login" && path !== "/api/me") {
    showLogin();
    throw new Error("Login required");
  }
  if (!response.ok) {
    let message = `Request failed: ${response.status}`;
    try {
      const error = await response.json();
      message = error.error ?? message;
    } catch {
      message = await response.text();
    }
    throw new Error(message);
  }

  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    return response.json();
  }
  return response.blob();
}

async function bootstrap() {
  try {
    const session = await api("/api/me");
    currentUser = session.user;
    showApp();
    await loadState();
    if (currentUser.isAdmin) await loadUsers();
  } catch {
    showLogin();
  }
}

function showLogin() {
  currentUser = null;
  authShell.hidden = false;
  appShell.hidden = true;
  loginPassword.value = "";
  loginUsername.focus();
}

function showApp() {
  authShell.hidden = true;
  appShell.hidden = false;
  currentUserLabel.textContent = `${currentUser.username}${currentUser.isAdmin ? " · Admin" : ""}`;
  userPanel.hidden = !currentUser.isAdmin;
}

async function login(event) {
  event.preventDefault();
  loginMessage.textContent = "Signing in...";
  try {
    const result = await api("/api/login", {
      method: "POST",
      body: JSON.stringify({
        username: loginUsername.value.trim(),
        password: loginPassword.value
      })
    });
    currentUser = result.user;
    loginForm.reset();
    loginMessage.textContent = "Use your Cardwell account to continue.";
    showApp();
    await loadState();
    if (currentUser.isAdmin) await loadUsers();
  } catch (error) {
    loginMessage.textContent = error.message;
  }
}

async function logout() {
  await api("/api/logout", { method: "POST" });
  state = { decks: [] };
  activeDeckId = null;
  showLogin();
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  themeToggleButton.textContent = theme === "dark" ? "Light" : "Dark";
}

function toggleTheme() {
  const nextTheme = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  localStorage.setItem(themeKey, nextTheme);
  applyTheme(nextTheme);
}

async function loadState(preferredDeckId = activeDeckId) {
  try {
    state = await api("/api/state");
    activeDeckId = state.decks.some((deck) => deck.id === preferredDeckId)
      ? preferredDeckId
      : state.decks[0]?.id ?? null;
    render();
  } catch (error) {
    renderFatalError(error);
  }
}

async function loadUsers() {
  if (!currentUser?.isAdmin) return;
  const result = await api("/api/users");
  users = result.users;
  renderUsers();
}

function renderFatalError(error) {
  deckTitle.textContent = "Unable to load Cardwell";
  studyText.textContent = "The server is not responding. Check the container logs and refresh.";
  cardList.innerHTML = `<p class="empty-state">${escapeHtml(error.message)}</p>`;
}

function getActiveDeck() {
  return state.decks.find((deck) => deck.id === activeDeckId) ?? state.decks[0] ?? null;
}

function canEdit(deck) {
  return ["owner", "editor"].includes(deck?.role);
}

function isOwner(deck) {
  return deck?.role === "owner";
}

function render() {
  const deck = getActiveDeck();
  if (deck && deck.id !== activeDeckId) activeDeckId = deck.id;
  collectionSummary.textContent = `${state.decks.length} ${state.decks.length === 1 ? "deck" : "decks"}`;
  renderDecks();
  renderDeckWorkspace();
}

function renderDecks() {
  deckList.replaceChildren();
  const template = document.querySelector("#deckTemplate");

  state.decks.forEach((deck) => {
    const node = template.content.firstElementChild.cloneNode(true);
    node.dataset.deckId = deck.id;
    node.classList.toggle("active", deck.id === activeDeckId);
    node.querySelector(".deck-name").textContent = deck.name;
    node.querySelector(".deck-count").textContent = `${deck.cards.length} · ${deck.role}`;
    node.addEventListener("click", () => {
      activeDeckId = deck.id;
      resetStudy();
      resetForm();
      render();
    });
    deckList.append(node);
  });
}

function renderDeckWorkspace() {
  const deck = getActiveDeck();
  const hasDeck = Boolean(deck);
  const editable = canEdit(deck);
  document.querySelector("#renameDeckButton").disabled = !editable;
  document.querySelector("#deleteDeckButton").disabled = !isOwner(deck);
  cardForm.querySelectorAll("textarea, button").forEach((control) => {
    control.disabled = !editable;
  });
  accessForm.querySelectorAll("input, select, button").forEach((control) => {
    control.disabled = !isOwner(deck);
  });

  if (!hasDeck) {
    deckTitle.textContent = "No deck selected";
    statCards.textContent = "0";
    statDue.textContent = "0";
    statMastered.textContent = "0";
    studyLabel.textContent = "Question";
    studyText.textContent = "Create a deck to begin.";
    deckRoleLabel.textContent = "No deck selected";
    flipButton.disabled = true;
    ratingActions.hidden = true;
    renderCards();
    renderAccess();
    return;
  }

  const now = Date.now();
  const due = deck.cards.filter((card) => card.dueAt <= now);
  const mastered = deck.cards.filter((card) => card.interval >= 14);
  deckTitle.textContent = deck.name;
  statCards.textContent = deck.cards.length;
  statDue.textContent = due.length;
  statMastered.textContent = mastered.length;
  deckRoleLabel.textContent = `Your role: ${deck.role}`;
  chooseStudyCard(deck);
  renderStudyCard(deck);
  renderCards();
  renderAccess();
}

function chooseStudyCard(deck) {
  if (currentStudyCardId && deck.cards.some((card) => card.id === currentStudyCardId)) return;
  const now = Date.now();
  const dueCards = deck.cards
    .filter((card) => card.dueAt <= now)
    .sort((a, b) => a.dueAt - b.dueAt);
  currentStudyCardId = dueCards[0]?.id ?? deck.cards[0]?.id ?? null;
  showingAnswer = false;
}

function renderStudyCard(deck) {
  const card = deck.cards.find((item) => item.id === currentStudyCardId);
  ratingActions.hidden = !showingAnswer || !card;

  if (!card) {
    studyLabel.textContent = "Question";
    studyText.textContent = "Add a card to begin.";
    flipButton.disabled = true;
    return;
  }

  flipButton.disabled = false;
  studyLabel.textContent = showingAnswer ? "Answer" : "Question";
  studyText.textContent = showingAnswer ? card.back : card.front;
}

function renderCards() {
  const deck = getActiveDeck();
  cardList.replaceChildren();

  if (!deck) {
    cardList.innerHTML = '<p class="empty-state">Create a deck to add cards.</p>';
    return;
  }

  const query = searchInput.value.trim().toLowerCase();
  const cards = deck.cards.filter((card) => `${card.front} ${card.back}`.toLowerCase().includes(query));

  if (!cards.length) {
    cardList.innerHTML = '<p class="empty-state">No cards found.</p>';
    return;
  }

  const template = document.querySelector("#cardTemplate");
  cards.forEach((card) => {
    const node = template.content.firstElementChild.cloneNode(true);
    node.querySelector("h4").textContent = card.front;
    node.querySelector("p").textContent = card.back;
    node.querySelector(".edit-card").disabled = !canEdit(deck);
    node.querySelector(".delete-card").disabled = !canEdit(deck);
    node.querySelector(".edit-card").addEventListener("click", () => editCard(card.id));
    node.querySelector(".delete-card").addEventListener("click", () => deleteCard(card.id));
    cardList.append(node);
  });
}

function renderAccess() {
  const deck = getActiveDeck();
  accessList.replaceChildren();
  if (!deck) {
    accessList.innerHTML = '<p class="empty-state">Select a deck to manage access.</p>';
    return;
  }
  if (!isOwner(deck)) {
    accessList.innerHTML = '<p class="empty-state">Only deck owners can manage sharing.</p>';
    return;
  }
  deck.access.forEach((entry) => {
    const row = document.createElement("article");
    row.className = "access-row";
    const details = document.createElement("div");
    details.innerHTML = `<strong>${escapeHtml(entry.username)}</strong><p>${escapeHtml(entry.role)}</p>`;
    row.append(details);
    if (isOwner(deck) && entry.userId !== currentUser.id) {
      const removeButton = document.createElement("button");
      removeButton.className = "danger";
      removeButton.type = "button";
      removeButton.textContent = "Remove";
      removeButton.addEventListener("click", () => revokeDeckAccess(entry.userId));
      row.append(removeButton);
    }
    accessList.append(row);
  });
}

function renderUsers() {
  userList.replaceChildren();
  users.forEach((user) => {
    const row = document.createElement("article");
    row.className = "access-row";
    row.innerHTML = `<div><strong>${escapeHtml(user.username)}</strong><p>${user.isAdmin ? "Admin" : "User"}</p></div>`;
    userList.append(row);
  });
}

async function createDeck() {
  const name = prompt("Deck name");
  if (!name?.trim()) return;

  try {
    const deck = await api("/api/decks", {
      method: "POST",
      body: JSON.stringify({ name: name.trim() })
    });
    activeDeckId = deck.id;
    resetStudy();
    await loadState(deck.id);
  } catch (error) {
    alert(error.message);
  }
}

async function renameDeck() {
  const deck = getActiveDeck();
  if (!deck) return;
  const name = prompt("Deck name", deck.name);
  if (!name?.trim()) return;

  try {
    await api(`/api/decks/${deck.id}`, {
      method: "PATCH",
      body: JSON.stringify({ name: name.trim() })
    });
    await loadState(deck.id);
  } catch (error) {
    alert(error.message);
  }
}

async function deleteDeck() {
  const deck = getActiveDeck();
  if (!deck) return;
  const confirmed = confirm(`Delete "${deck.name}" and all of its cards?`);
  if (!confirmed) return;

  try {
    await api(`/api/decks/${deck.id}`, { method: "DELETE" });
    activeDeckId = null;
    resetStudy();
    resetForm();
    await loadState();
  } catch (error) {
    alert(error.message);
  }
}

async function saveCard(event) {
  event.preventDefault();
  const deck = getActiveDeck();
  if (!deck) return;

  const front = frontInput.value.trim();
  const back = backInput.value.trim();
  if (!front || !back) return;

  try {
    if (editingCardId) {
      await api(`/api/cards/${editingCardId}`, {
        method: "PATCH",
        body: JSON.stringify({ front, back })
      });
    } else {
      await api(`/api/decks/${deck.id}/cards`, {
        method: "POST",
        body: JSON.stringify({ front, back })
      });
    }

    resetForm();
    resetStudy();
    await loadState(deck.id);
  } catch (error) {
    alert(error.message);
  }
}

function editCard(cardId) {
  const deck = getActiveDeck();
  if (!canEdit(deck)) return;
  const card = deck?.cards.find((item) => item.id === cardId);
  if (!card) return;

  editingCardId = card.id;
  frontInput.value = card.front;
  backInput.value = card.back;
  formTitle.textContent = "Edit card";
  saveCardButton.textContent = "Save changes";
  cancelEditButton.hidden = false;
  frontInput.focus();
}

async function deleteCard(cardId) {
  const deck = getActiveDeck();
  if (!canEdit(deck)) return;
  const card = deck.cards.find((item) => item.id === cardId);
  if (!card || !confirm("Delete this card?")) return;

  try {
    await api(`/api/cards/${cardId}`, { method: "DELETE" });
    if (currentStudyCardId === cardId) resetStudy();
    if (editingCardId === cardId) resetForm();
    await loadState(deck.id);
  } catch (error) {
    alert(error.message);
  }
}

async function shareDeck(event) {
  event.preventDefault();
  const deck = getActiveDeck();
  if (!isOwner(deck)) return;
  try {
    await api(`/api/decks/${deck.id}/access`, {
      method: "POST",
      body: JSON.stringify({
        username: shareUsernameInput.value.trim(),
        role: shareRoleInput.value
      })
    });
    accessForm.reset();
    await loadState(deck.id);
  } catch (error) {
    alert(error.message);
  }
}

async function revokeDeckAccess(userId) {
  const deck = getActiveDeck();
  if (!isOwner(deck) || !confirm("Remove this user's deck access?")) return;
  try {
    await api(`/api/decks/${deck.id}/access/${userId}`, { method: "DELETE" });
    await loadState(deck.id);
  } catch (error) {
    alert(error.message);
  }
}

async function createUser(event) {
  event.preventDefault();
  try {
    await api("/api/users", {
      method: "POST",
      body: JSON.stringify({
        username: newUsernameInput.value.trim(),
        password: newPasswordInput.value,
        isAdmin: newUserAdminInput.checked
      })
    });
    userForm.reset();
    await loadUsers();
  } catch (error) {
    alert(error.message);
  }
}

function resetForm() {
  editingCardId = null;
  cardForm.reset();
  formTitle.textContent = "Add card";
  saveCardButton.textContent = "Add card";
  cancelEditButton.hidden = true;
}

function resetStudy() {
  currentStudyCardId = null;
  showingAnswer = false;
}

function flipStudyCard() {
  const deck = getActiveDeck();
  if (!deck || !currentStudyCardId) return;
  showingAnswer = !showingAnswer;
  renderStudyCard(deck);
}

async function rateCard(event) {
  const button = event.target.closest("button[data-rating]");
  if (!button) return;
  const deck = getActiveDeck();
  const card = deck?.cards.find((item) => item.id === currentStudyCardId);
  if (!card) return;

  try {
    await api(`/api/cards/${card.id}/review`, {
      method: "POST",
      body: JSON.stringify({ rating: button.dataset.rating })
    });
    currentStudyCardId = null;
    showingAnswer = false;
    await loadState(deck.id);
  } catch (error) {
    alert(error.message);
  }
}

async function exportBackup() {
  try {
    const blob = await api("/api/export");
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `cardwell-backup-${new Date().toISOString().slice(0, 10)}.json`;
    link.click();
    URL.revokeObjectURL(url);
  } catch (error) {
    alert(error.message);
  }
}

async function importBackup(event) {
  const [file] = event.target.files;
  if (!file) return;

  try {
    const imported = JSON.parse(await file.text());
    if (!Array.isArray(imported.decks)) throw new Error("Invalid backup");
    const result = await api("/api/import", {
      method: "POST",
      body: JSON.stringify(imported)
    });
    activeDeckId = result.deckIds?.[0] ?? null;
    resetStudy();
    resetForm();
    await loadState(activeDeckId);
  } catch {
    alert("That backup file could not be imported.");
  } finally {
    event.target.value = "";
  }
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => {
    return {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#039;"
    }[character];
  });
}

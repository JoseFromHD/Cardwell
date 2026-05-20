let state = { decks: [] };
let activeDeckId = null;
let editingCardId = null;
let currentStudyCardId = null;
let showingAnswer = false;

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

document.querySelector("#newDeckButton").addEventListener("click", createDeck);
document.querySelector("#renameDeckButton").addEventListener("click", renameDeck);
document.querySelector("#deleteDeckButton").addEventListener("click", deleteDeck);
document.querySelector("#exportButton").addEventListener("click", exportBackup);
document.querySelector("#importInput").addEventListener("change", importBackup);
flipButton.addEventListener("click", flipStudyCard);
ratingActions.addEventListener("click", rateCard);
cardForm.addEventListener("submit", saveCard);
cancelEditButton.addEventListener("click", resetForm);
searchInput.addEventListener("input", renderCards);

loadState();

async function api(path, options = {}) {
  const headers = { ...(options.headers ?? {}) };
  if (options.body && !(options.body instanceof FormData)) {
    headers["Content-Type"] = "application/json";
  }

  const response = await fetch(path, { ...options, headers });
  if (!response.ok) {
    const message = await response.text();
    throw new Error(message || `Request failed: ${response.status}`);
  }

  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    return response.json();
  }
  return response.blob();
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

function renderFatalError(error) {
  deckTitle.textContent = "Unable to load Cardwell";
  studyText.textContent = "The server is not responding. Check the container logs and refresh.";
  cardList.innerHTML = `<p class="empty-state">${escapeHtml(error.message)}</p>`;
}

function getActiveDeck() {
  return state.decks.find((deck) => deck.id === activeDeckId) ?? state.decks[0] ?? null;
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
    node.querySelector(".deck-count").textContent = deck.cards.length;
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
  document.querySelector("#renameDeckButton").disabled = !hasDeck;
  document.querySelector("#deleteDeckButton").disabled = !hasDeck;
  cardForm.querySelectorAll("textarea, button").forEach((control) => {
    control.disabled = !hasDeck;
  });

  if (!deck) {
    deckTitle.textContent = "No deck selected";
    statCards.textContent = "0";
    statDue.textContent = "0";
    statMastered.textContent = "0";
    studyLabel.textContent = "Question";
    studyText.textContent = "Create a deck to begin.";
    flipButton.disabled = true;
    ratingActions.hidden = true;
    renderCards();
    return;
  }

  const now = Date.now();
  const due = deck.cards.filter((card) => card.dueAt <= now);
  const mastered = deck.cards.filter((card) => card.interval >= 14);
  deckTitle.textContent = deck.name;
  statCards.textContent = deck.cards.length;
  statDue.textContent = due.length;
  statMastered.textContent = mastered.length;
  chooseStudyCard(deck);
  renderStudyCard(deck);
  renderCards();
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
  const cards = deck.cards.filter((card) => {
    return `${card.front} ${card.back}`.toLowerCase().includes(query);
  });

  if (!cards.length) {
    cardList.innerHTML = '<p class="empty-state">No cards found.</p>';
    return;
  }

  const template = document.querySelector("#cardTemplate");
  cards.forEach((card) => {
    const node = template.content.firstElementChild.cloneNode(true);
    node.querySelector("h4").textContent = card.front;
    node.querySelector("p").textContent = card.back;
    node.querySelector(".edit-card").addEventListener("click", () => editCard(card.id));
    node.querySelector(".delete-card").addEventListener("click", () => deleteCard(card.id));
    cardList.append(node);
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
  if (!deck) return;
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
    await api("/api/import", {
      method: "POST",
      body: JSON.stringify(imported)
    });
    activeDeckId = imported.decks[0]?.id ?? null;
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
  return value.replace(/[&<>"']/g, (character) => {
    return {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#039;"
    }[character];
  });
}

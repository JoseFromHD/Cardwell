const themeKey = "cardwell:theme";

let currentUser = null;
let state = { decks: [] };
let users = [];
let activeDeckId = null;
let editingCardId = null;
let currentStudyCardId = null;
let showingAnswer = false;
let lastGeneratedCredential = null;
let studyMode = "cards";
let learnFeedbackMessage = "";
let testSession = null;
let matchSession = null;
let matchTimerId = null;
let drillDeck = [];
let drillIndex = 0;

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
const studyModeTabs = document.querySelector("#studyModeTabs");
const studyOptions = document.querySelector("#studyOptions");
const studyDirectionInput = document.querySelector("#studyDirectionInput");
const studyShuffleInput = document.querySelector("#studyShuffleInput");
const studyCard = document.querySelector("#studyCard");
const studyLabel = document.querySelector("#studyLabel");
const studyFrontText = document.querySelector("#studyFrontText");
const studyBackText = document.querySelector("#studyBackText");
const flipButton = document.querySelector("#flipButton");
const learnForm = document.querySelector("#learnForm");
const learnAnswerInput = document.querySelector("#learnAnswerInput");
const learnFeedback = document.querySelector("#learnFeedback");
const ratingActions = document.querySelector("#ratingActions");
const drillActions = document.querySelector("#drillActions");
const drillProgress = document.querySelector("#drillProgress");
const nextDrillButton = document.querySelector("#nextDrillButton");
const testPanel = document.querySelector("#testPanel");
const testSummary = document.querySelector("#testSummary");
const testList = document.querySelector("#testList");
const startTestButton = document.querySelector("#startTestButton");
const submitTestButton = document.querySelector("#submitTestButton");
const matchPanel = document.querySelector("#matchPanel");
const matchSummary = document.querySelector("#matchSummary");
const matchGrid = document.querySelector("#matchGrid");
const startMatchButton = document.querySelector("#startMatchButton");
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
const newAccountRoleInput = document.querySelector("#newAccountRoleInput");
const generateNewPasswordButton = document.querySelector("#generateNewPasswordButton");
const userList = document.querySelector("#userList");
const userSummary = document.querySelector("#userSummary");
const generatedCredential = document.querySelector("#generatedCredential");
const generatedCredentialTitle = document.querySelector("#generatedCredentialTitle");
const generatedCredentialUsername = document.querySelector("#generatedCredentialUsername");
const generatedCredentialPassword = document.querySelector("#generatedCredentialPassword");
const copyGeneratedCredential = document.querySelector("#copyGeneratedCredential");

document.querySelector("#newDeckButton").addEventListener("click", createDeck);
document.querySelector("#renameDeckButton").addEventListener("click", renameDeck);
document.querySelector("#deleteDeckButton").addEventListener("click", deleteDeck);
document.querySelector("#exportButton").addEventListener("click", exportBackup);
document.querySelector("#importInput").addEventListener("change", importBackup);
loginForm.addEventListener("submit", login);
logoutButton.addEventListener("click", logout);
themeToggleButton.addEventListener("click", toggleTheme);
studyModeTabs.addEventListener("click", changeStudyMode);
studyDirectionInput.addEventListener("change", resetStudyModeState);
studyShuffleInput.addEventListener("change", resetStudyModeState);
flipButton.addEventListener("click", flipStudyCard);
learnForm.addEventListener("submit", submitLearnAnswer);
ratingActions.addEventListener("click", rateCard);
nextDrillButton.addEventListener("click", nextDrillCard);
startTestButton.addEventListener("click", startTestMode);
submitTestButton.addEventListener("click", scoreTestMode);
startMatchButton.addEventListener("click", startMatchMode);
matchGrid.addEventListener("click", selectMatchTile);
cardForm.addEventListener("submit", saveCard);
cancelEditButton.addEventListener("click", resetForm);
searchInput.addEventListener("input", renderCards);
accessForm.addEventListener("submit", shareDeck);
userForm.addEventListener("submit", createUser);
generateNewPasswordButton.addEventListener("click", generatePasswordForNewAccount);
copyGeneratedCredential.addEventListener("click", copyLastGeneratedCredential);

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
  studyFrontText.textContent = "The server is not responding. Check the container logs and refresh.";
  studyBackText.textContent = "The server is not responding. Check the container logs and refresh.";
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
    studyFrontText.textContent = "Create a deck to begin.";
    studyBackText.textContent = "Create a deck to begin.";
    flipButton.classList.remove("flipped");
    deckRoleLabel.textContent = "No deck selected";
    flipButton.disabled = true;
    studyCard.hidden = false;
    learnForm.hidden = true;
    ratingActions.hidden = true;
    drillActions.hidden = true;
    testPanel.hidden = true;
    matchPanel.hidden = true;
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
  renderStudySurface(deck);
  renderCards();
  renderAccess();
}

function renderStudySurface(deck) {
  studyModeTabs.querySelectorAll("button").forEach((button) => {
    button.classList.toggle("active", button.dataset.studyMode === studyMode);
  });
  const needsDirection = ["cards", "drill", "learn", "test", "match"].includes(studyMode);
  studyOptions.hidden = !needsDirection;
  studyCard.hidden = !["cards", "drill", "learn"].includes(studyMode);
  learnForm.hidden = studyMode !== "learn";
  testPanel.hidden = studyMode !== "test";
  matchPanel.hidden = studyMode !== "match";
  ratingActions.hidden = true;
  drillActions.hidden = true;

  if (studyMode === "test") {
    renderTestMode(deck);
    return;
  }

  if (studyMode === "match") {
    renderMatchMode(deck);
    return;
  }

  if (studyMode === "drill") {
    chooseDrillCard(deck);
    renderStudyCard(deck);
    return;
  }

  chooseStudyCard(deck);
  renderStudyCard(deck);
}

function chooseStudyCard(deck) {
  if (currentStudyCardId && deck.cards.some((card) => card.id === currentStudyCardId)) return;
  const now = Date.now();
  const dueCards = deck.cards
    .filter((card) => card.dueAt <= now)
    .sort((a, b) => a.dueAt - b.dueAt);
  const candidates = dueCards.length ? dueCards : deck.cards;
  currentStudyCardId = studyShuffleInput.checked
    ? sample(candidates)?.id ?? null
    : candidates[0]?.id ?? null;
  showingAnswer = false;
}

function renderStudyCard(deck) {
  const card = deck.cards.find((item) => item.id === currentStudyCardId);
  ratingActions.hidden = studyMode !== "cards" || !showingAnswer || !card;
  drillActions.hidden = studyMode !== "drill" || !showingAnswer || !card;
  learnFeedback.textContent = learnFeedbackMessage;

  if (!card) {
    studyLabel.textContent = "Question";
    studyFrontText.textContent = "Add a card to begin.";
    studyBackText.textContent = "Add a card to begin.";
    flipButton.classList.remove("flipped");
    flipButton.disabled = true;
    drillProgress.textContent = "0 / 0";
    learnForm.querySelectorAll("input, button").forEach((control) => {
      control.disabled = true;
    });
    return;
  }

  const pair = getStudyPair(card);
  flipButton.disabled = false;
  learnForm.querySelectorAll("input, button").forEach((control) => {
    control.disabled = false;
  });
  studyLabel.textContent = showingAnswer ? "Answer" : studyMode === "learn" ? "Learn" : "Question";
  studyFrontText.textContent = pair.prompt;
  studyBackText.textContent = pair.answer;
  flipButton.classList.toggle("flipped", ["cards", "drill"].includes(studyMode) && showingAnswer);
  if (studyMode === "drill") {
    drillProgress.textContent = `${Math.min(drillIndex + 1, drillDeck.length)} / ${drillDeck.length}`;
    nextDrillButton.textContent = drillIndex >= drillDeck.length - 1 ? "Restart" : "Next card";
  }
}

function chooseDrillCard(deck) {
  if (!deck.cards.length) {
    currentStudyCardId = null;
    drillDeck = [];
    drillIndex = 0;
    return;
  }

  const ids = deck.cards.map((card) => card.id);
  const deckChanged = drillDeck.length !== ids.length || drillDeck.some((id) => !ids.includes(id));
  if (!drillDeck.length || deckChanged) {
    drillDeck = shuffle(ids);
    drillIndex = 0;
  }
  currentStudyCardId = drillDeck[drillIndex] ?? null;
}

function nextDrillCard() {
  const deck = getActiveDeck();
  if (!deck?.cards.length) return;
  if (drillIndex >= drillDeck.length - 1) {
    drillDeck = shuffle(deck.cards.map((card) => card.id));
    drillIndex = 0;
  } else {
    drillIndex += 1;
  }
  currentStudyCardId = drillDeck[drillIndex] ?? null;
  showingAnswer = false;
  renderStudySurface(deck);
}

function changeStudyMode(event) {
  const button = event.target.closest("button[data-study-mode]");
  if (!button) return;
  studyMode = button.dataset.studyMode;
  resetStudyModeState();
}

function resetStudyModeState() {
  resetStudy();
  learnFeedbackMessage = "";
  learnAnswerInput.value = "";
  testSession = null;
  stopMatchTimer();
  matchSession = null;
  drillDeck = [];
  drillIndex = 0;
  render();
}

function getStudyPair(card) {
  if (studyDirectionInput.value === "back") {
    return { prompt: card.back, answer: card.front };
  }
  return { prompt: card.front, answer: card.back };
}

function getPracticeCards(deck, limit = 10) {
  const cards = studyShuffleInput.checked ? shuffle(deck.cards) : [...deck.cards];
  return cards.slice(0, limit);
}

function sample(items) {
  if (!items.length) return null;
  const [value] = crypto.getRandomValues(new Uint32Array(1));
  return items[value % items.length];
}

function shuffle(items) {
  const copy = [...items];
  const bytes = new Uint32Array(copy.length);
  crypto.getRandomValues(bytes);
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const swapIndex = bytes[index] % (index + 1);
    [copy[index], copy[swapIndex]] = [copy[swapIndex], copy[index]];
  }
  return copy;
}

function normalizeAnswer(value) {
  return String(value)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function isAnswerCorrect(answer, expected) {
  return normalizeAnswer(answer) === normalizeAnswer(expected);
}

async function submitLearnAnswer(event) {
  event.preventDefault();
  const deck = getActiveDeck();
  const card = deck?.cards.find((item) => item.id === currentStudyCardId);
  if (!card) return;

  const pair = getStudyPair(card);
  const answer = learnAnswerInput.value.trim();
  if (!answer) return;

  const correct = isAnswerCorrect(answer, pair.answer);
  learnFeedbackMessage = correct
    ? "Correct. Cardwell will space this card out."
    : `Not quite. Answer: ${pair.answer}`;

  try {
    await api(`/api/cards/${card.id}/review`, {
      method: "POST",
      body: JSON.stringify({ rating: correct ? "good" : "again" })
    });
    learnAnswerInput.value = "";
    currentStudyCardId = null;
    showingAnswer = false;
    await loadState(deck.id);
  } catch (error) {
    alert(error.message);
  }
}

function startTestMode() {
  const deck = getActiveDeck();
  if (!deck?.cards.length) return;
  testSession = {
    scored: false,
    questions: buildTestQuestions(deck)
  };
  renderTestMode(deck);
}

function buildTestQuestions(deck) {
  return getPracticeCards(deck, 10).map((card, index) => {
    const pair = getStudyPair(card);
    const type = deck.cards.length >= 4 && index % 2 === 0 ? "choice" : "written";
    const distractors = shuffle(deck.cards)
      .filter((candidate) => candidate.id !== card.id)
      .map((candidate) => getStudyPair(candidate).answer)
      .filter((answer, answerIndex, answers) => answers.indexOf(answer) === answerIndex)
      .slice(0, 3);
    return {
      id: card.id,
      type,
      prompt: pair.prompt,
      answer: pair.answer,
      choices: type === "choice" ? shuffle([pair.answer, ...distractors]) : [],
      response: "",
      correct: false
    };
  });
}

function renderTestMode(deck) {
  testList.replaceChildren();
  startTestButton.disabled = !deck.cards.length;
  submitTestButton.hidden = !testSession || testSession.scored;

  if (!testSession) {
    testSummary.textContent = deck.cards.length
      ? `Generate up to ${Math.min(deck.cards.length, 10)} written and multiple-choice questions.`
      : "Add cards to generate a test.";
    return;
  }

  if (testSession.scored) {
    const correct = testSession.questions.filter((question) => question.correct).length;
    testSummary.textContent = `Score: ${correct}/${testSession.questions.length}`;
    startTestButton.textContent = "New test";
  } else {
    testSummary.textContent = `${testSession.questions.length} questions ready.`;
    startTestButton.textContent = "Restart";
  }

  testSession.questions.forEach((question, index) => {
    const item = document.createElement("article");
    const title = document.createElement("h4");
    const prompt = document.createElement("p");

    item.className = `test-question ${testSession.scored ? (question.correct ? "correct" : "incorrect") : ""}`;
    title.textContent = `${index + 1}. ${question.type === "choice" ? "Choose the answer" : "Write the answer"}`;
    prompt.textContent = question.prompt;
    item.append(title, prompt);

    if (question.type === "choice") {
      const group = document.createElement("div");
      group.className = "choice-list";
      question.choices.forEach((choice) => {
        const label = document.createElement("label");
        const input = document.createElement("input");
        input.type = "radio";
        input.name = `test-${index}`;
        input.value = choice;
        input.checked = question.response === choice;
        input.disabled = testSession.scored;
        label.append(input, document.createTextNode(choice));
        group.append(label);
      });
      item.append(group);
    } else {
      const input = document.createElement("input");
      input.dataset.testIndex = index;
      input.placeholder = "Type your answer";
      input.value = question.response;
      input.disabled = testSession.scored;
      item.append(input);
    }

    if (testSession.scored) {
      const answer = document.createElement("p");
      answer.className = "mode-feedback";
      answer.textContent = question.correct ? "Correct" : `Answer: ${question.answer}`;
      item.append(answer);
    }

    testList.append(item);
  });
}

function scoreTestMode() {
  if (!testSession) return;

  testSession.questions.forEach((question, index) => {
    if (question.type === "choice") {
      const checked = testList.querySelector(`input[name="test-${index}"]:checked`);
      question.response = checked?.value ?? "";
    } else {
      const input = testList.querySelector(`input[data-test-index="${index}"]`);
      question.response = input?.value ?? "";
    }
    question.correct = isAnswerCorrect(question.response, question.answer);
  });
  testSession.scored = true;
  renderTestMode(getActiveDeck());
}

function startMatchMode() {
  const deck = getActiveDeck();
  if (!deck?.cards.length) return;
  const cards = getPracticeCards(deck, 6);
  matchSession = {
    startedAt: Date.now(),
    completedAt: null,
    selectedId: null,
    matchedPairs: new Set(),
    tiles: shuffle(cards.flatMap((card) => {
      const pair = getStudyPair(card);
      return [
        { id: `${card.id}:prompt`, pairId: card.id, side: "prompt", text: pair.prompt },
        { id: `${card.id}:answer`, pairId: card.id, side: "answer", text: pair.answer }
      ];
    }))
  };
  startMatchTimer();
  renderMatchMode(deck);
}

function renderMatchMode(deck) {
  matchGrid.replaceChildren();
  startMatchButton.disabled = !deck.cards.length;

  if (!matchSession) {
    matchSummary.textContent = deck.cards.length
      ? `Match ${Math.min(deck.cards.length, 6)} pairs. Smaller decks make faster rounds.`
      : "Add cards to start Match.";
    return;
  }

  const elapsed = getMatchElapsedSeconds();
  if (matchSession.completedAt) {
    matchSummary.textContent = `Complete in ${elapsed}s.`;
    startMatchButton.textContent = "Play again";
  } else {
    matchSummary.textContent = `Time: ${elapsed}s · ${matchSession.matchedPairs.size}/${matchSession.tiles.length / 2} matched`;
    startMatchButton.textContent = "Restart";
  }

  matchSession.tiles.forEach((tile) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "match-tile";
    button.dataset.tileId = tile.id;
    button.textContent = tile.text;
    button.disabled = matchSession.matchedPairs.has(tile.pairId);
    button.classList.toggle("selected", matchSession.selectedId === tile.id);
    button.classList.toggle("matched", matchSession.matchedPairs.has(tile.pairId));
    matchGrid.append(button);
  });
}

function selectMatchTile(event) {
  const button = event.target.closest("button[data-tile-id]");
  if (!button || !matchSession || matchSession.completedAt) return;
  const tile = matchSession.tiles.find((candidate) => candidate.id === button.dataset.tileId);
  if (!tile || matchSession.matchedPairs.has(tile.pairId)) return;

  if (!matchSession.selectedId) {
    matchSession.selectedId = tile.id;
    renderMatchMode(getActiveDeck());
    return;
  }

  const selected = matchSession.tiles.find((candidate) => candidate.id === matchSession.selectedId);
  if (selected?.id === tile.id) {
    matchSession.selectedId = null;
  } else if (selected?.pairId === tile.pairId && selected.side !== tile.side) {
    matchSession.matchedPairs.add(tile.pairId);
    matchSession.selectedId = null;
    if (matchSession.matchedPairs.size === matchSession.tiles.length / 2) {
      matchSession.completedAt = Date.now();
      stopMatchTimer();
    }
  } else {
    matchSession.selectedId = tile.id;
  }
  renderMatchMode(getActiveDeck());
}

function startMatchTimer() {
  stopMatchTimer();
  matchTimerId = setInterval(() => {
    if (studyMode === "match" && matchSession && !matchSession.completedAt) {
      renderMatchMode(getActiveDeck());
    }
  }, 1000);
}

function stopMatchTimer() {
  if (matchTimerId) {
    clearInterval(matchTimerId);
    matchTimerId = null;
  }
}

function getMatchElapsedSeconds() {
  if (!matchSession) return 0;
  const endTime = matchSession.completedAt ?? Date.now();
  return Math.max(0, Math.round((endTime - matchSession.startedAt) / 1000));
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
  const owners = users.filter((user) => user.isAdmin).length;
  userSummary.textContent = `${users.length} ${users.length === 1 ? "account" : "accounts"} · ${owners} ${owners === 1 ? "owner" : "owners"}`;

  users.forEach((user) => {
    const row = document.createElement("article");
    const details = document.createElement("div");
    const username = document.createElement("strong");
    const role = document.createElement("span");
    const resetButton = document.createElement("button");

    row.className = "user-row";
    details.className = "user-details";
    username.textContent = user.username;
    role.className = `role-badge ${user.isAdmin ? "owner" : "user"}`;
    role.textContent = user.isAdmin ? "Owner" : "Study user";
    resetButton.className = "ghost";
    resetButton.type = "button";
    resetButton.textContent = "Reset password";
    resetButton.addEventListener("click", () => resetUserPassword(user));

    details.append(username, role);
    row.append(details, resetButton);
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
  const password = newPasswordInput.value.trim();
  try {
    const result = await api("/api/users", {
      method: "POST",
      body: JSON.stringify({
        username: newUsernameInput.value.trim(),
        password,
        generatePassword: !password,
        isAdmin: newAccountRoleInput.value === "owner"
      })
    });
    if (result.temporaryPassword) {
      showGeneratedCredential("Account created", result.username, result.temporaryPassword);
    } else {
      hideGeneratedCredential();
    }
    userForm.reset();
    await loadUsers();
  } catch (error) {
    alert(error.message);
  }
}

async function resetUserPassword(user) {
  if (!confirm(`Reset password for ${user.username}?`)) return;

  try {
    const result = await api(`/api/users/${user.id}/password`, {
      method: "PATCH",
      body: JSON.stringify({ generatePassword: true })
    });
    showGeneratedCredential("Password reset", result.user.username, result.temporaryPassword);
  } catch (error) {
    alert(error.message);
  }
}

function generatePasswordForNewAccount() {
  newPasswordInput.value = randomPassword();
  newPasswordInput.focus();
}

function randomPassword(length = 20) {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%";
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join("");
}

function showGeneratedCredential(title, username, password) {
  lastGeneratedCredential = { username, password };
  generatedCredentialTitle.textContent = title;
  generatedCredentialUsername.textContent = username;
  generatedCredentialPassword.textContent = password;
  generatedCredential.hidden = false;
}

function hideGeneratedCredential() {
  lastGeneratedCredential = null;
  generatedCredential.hidden = true;
}

async function copyLastGeneratedCredential() {
  if (!lastGeneratedCredential) return;
  const value = `${lastGeneratedCredential.username}\n${lastGeneratedCredential.password}`;
  try {
    await navigator.clipboard.writeText(value);
    copyGeneratedCredential.textContent = "Copied";
    setTimeout(() => {
      copyGeneratedCredential.textContent = "Copy";
    }, 1600);
  } catch {
    alert(value);
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
  learnFeedbackMessage = "";
  testSession = null;
  stopMatchTimer();
  matchSession = null;
  drillDeck = [];
  drillIndex = 0;
}

function flipStudyCard() {
  if (!["cards", "drill"].includes(studyMode)) return;
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

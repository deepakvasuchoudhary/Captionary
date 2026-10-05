# Contributing to Captionary 🚀

Thank you for your interest in contributing to **Captionary**! We welcome contributions from developers, designers, and language learners worldwide.

---

## 📋 Code of Conduct

Please be respectful, constructive, and helpful when participating in discussions, reporting issues, or submitting pull requests.

---

## 🛠 Getting Started Locally

1. **Fork & Clone** the repository:
   ```bash
   git clone git@github.com:deepakvasuchoudhary/Captionary.git
   cd Captionary
   ```

2. **Load Unpacked in Google Chrome**:
   - Open Google Chrome and navigate to `chrome://extensions/`.
   - Enable **Developer mode** (toggle in the top-right corner).
   - Click **Load unpacked** (top-left).
   - Select the cloned project folder.

3. **Develop & Iterate**:
   - Make your changes in `content.js`, `background.js`, `content.css`, or the `popup/` folder.
   - Go to `chrome://extensions/` and click the **🔄 Reload** icon on the Captionary extension card.
   - Refresh your YouTube video tab to test your changes.

---

## 💡 How to Contribute

### 1. Reporting Bugs
- Check the [Issues](https://github.com/deepakvasuchoudhary/Captionary/issues) tab to see if the bug has already been reported.
- If not, open a new issue with:
  - Clear title and description of the bug
  - Steps to reproduce
  - The YouTube video URL where the issue occurred
  - Screenshots or console error logs if available

### 2. Suggesting Features
- Open an issue describing the proposed feature, user benefit, and possible implementation approach.

### 3. Submitting Pull Requests (PRs)
1. Create a feature branch:
   ```bash
   git checkout -b feature/your-feature-name
   ```
2. Commit your changes with descriptive messages:
   ```bash
   git commit -m "feat: add support for Italian pronunciation"
   ```
3. Push to your fork:
   ```bash
   git push origin feature/your-feature-name
   ```
4. Open a Pull Request against the `main` branch.

---

## 🎨 Coding Guidelines

- **Vanilla JavaScript & CSS**: We keep Captionary extremely lightweight and fast by using native DOM APIs without bulky frameworks or bundlers.
- **YouTube Native Theme Alignment**: Ensure styles look pixel-perfect in both YouTube Dark Mode (`#0f0f0f`) and Light Mode (`#ffffff`).
- **Non-blocking Performance**: Any external network requests (definitions, translations) must be decoupled, cached, and fail gracefully without freezing the video or UI.

---

## 📄 License

By contributing to Captionary, you agree that your contributions will be licensed under the [MIT License](LICENSE).

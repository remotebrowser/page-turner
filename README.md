# Page Turner

Page Turner is a web app that helps you connect and import your reading lists from Goodreads, providing a unified view of all your books across different shelves.

## Features

- **Connect Goodreads Account:** Securely connect your Goodreads account via a simple authentication flow.
- **Automatic Import:** Instantly fetch your book shelves and reading history.
- **Organized Dashboard:** View all your books organized by shelf (Reading History, Wish to Read, etc.).
- **Book Details:** See book covers, ratings, added dates, and links back to Goodreads.
- **Share Your Reading List:** Confirm and share your reading list to claim rewards.
- **Privacy-Focused:** Credentials are used only for session and never stored.

## How It Works

1. **Connect Account:** Use the onboarding flow to connect your Goodreads account via secure sign-in.
2. **Import Books:** The app fetches your book shelves and reading history.
3. **View Dashboard:** See all your books organized by shelf with covers and ratings.
4. **Share & Confirm:** Confirm sharing your reading list to claim rewards.

## Technical Overview

- **Frontend:** React (Vite), TypeScript, Tailwind CSS, React Router.
- **Backend:** Express.js with session management.
- **Integration:** Goodreads account connection via secure authentication.
- **Data Model:** Books include title, author, cover, rating, shelf, added date, and Goodreads URL.
- **Celebrations:** Confetti animation for confirmation milestones.
- **Error Tracking:** Sentry integration for both client and server-side error monitoring.

## Configuration

Create a `.env` file in the project root with the following variables:

```env
GETGATHER_URL=http://localhost:23456

# Sentry Configuration (optional)
SENTRY_DSN=https://your-dsn@sentry.io/project-id

```

The app will work without Sentry configuration - errors will simply not be tracked.

## Development

```bash
npm install
npm run dev
```

import os
import logging
from telegram import Update, ReplyKeyboardMarkup, KeyboardButton
from telegram.ext import Application, CommandHandler, MessageHandler, filters, ContextTypes

# Render console me errors dekhne ke liye logging
logging.basicConfig(format='%(asctime)s - %(name)s - %(levelname)s - %(message)s', level=logging.INFO)

async def start(update: Update, context: ContextTypes.DEFAULT_TYPE):
    # Wahi layout jo tumne bataya tha (2 rows, 2 columns)
    keyboard = [
        [KeyboardButton("📱 My Accounts"), KeyboardButton("🏠 Home")],
        [KeyboardButton("💰 Wallet"), KeyboardButton("➕ New Login")]
    ]
    reply_markup = ReplyKeyboardMarkup(keyboard, resize_keyboard=True)
    
    await update.message.reply_text(
        "Welcome to GbxXbb Dashboard! Please select an option:",
        reply_markup=reply_markup
    )

async def handle_menu(update: Update, context: ContextTypes.DEFAULT_TYPE):
    text = update.message.text
    
    if text == "📱 My Accounts":
        await update.message.reply_text("Aapke saved accounts ki list yahan show hogi...")
    elif text == "💰 Wallet":
        await update.message.reply_text("💵 Aapka current balance: ₹0.00\n\nPaise add karne ke liye jald hi QR system update hoga.")
    elif text == "➕ New Login":
        await update.message.reply_text("Apna generic phone number enter karein session track karne ke liye:")
    elif text == "🏠 Home":
        await update.message.reply_text("Aap main menu par hain. Niche diye gaye buttons use karein.")

def main():
    # Token ko environment variable se secure fetch karna
    TOKEN = os.getenv("BOT_TOKEN")
    
    if not TOKEN:
        print("ERROR: BOT_TOKEN variable nahi mila!")
        return

    app = Application.builder().token(TOKEN).build()
    
    # Command aur Message Handlers
    app.add_handler(CommandHandler("start", start))
    app.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, handle_menu))
    
    print("GbxXbb Bot is running...")
    app.run_polling()

if __name__ == '__main__':
    main()

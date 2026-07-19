import os
import logging
import urllib.request
import urllib.parse
import json
import random
import re
from fastapi import FastAPI, Request, Response
from fastapi.responses import FileResponse
from telegram import Update, ReplyKeyboardMarkup, KeyboardButton, InlineKeyboardMarkup, InlineKeyboardButton, WebAppInfo
from telegram.ext import Application, CommandHandler, MessageHandler, filters, ContextTypes, CallbackQueryHandler
from telegram.error import TelegramError

logging.basicConfig(format='%(asctime)s - %(name)s - %(levelname)s - %(message)s', level=logging.INFO)

# --- GLOBAL SYSTEM LAYERS CONFIG ---
REQUIRED_TARGETS = [
    -1003332858806, -1003630519339, -1003197501531, -1003862251237
]
TARGET_LINKS = {
    -1003332858806: "https://t.me/+6ByfGDRBKgsxMjZl",   
    -1003630519339: "https://t.me/+OWrCoeF-JutmNjg1",   
    -1003197501531: "https://t.me/+f2mWfDs6EUIxYTBl",   
    -1003862251237: "https://t.me/+O_-kEF2f5f1kMjdl"            
}
TARGET_LABELS = {
    -1003332858806: "📢 Join GBX LOOT", 
    -1003630519339: "📢 Join GBX EARN",
    -1003197501531: "📢 Join GBX Zone", 
    -1003862251237: "💬 Join Group Chat (GC)"
}

# 🛠️ ADMIN ACCOUNT ID CONFIGURATION
# (Yahan apni asli Telegram numerical chat ID daal dena taaki request tere paas aaye)
ADMIN_CHAT_ID = 8254886110 

# Databases
USER_BALANCES = {}
USER_STATES = {}
PENDING_TX = {}
USED_UTRS = set()

# BHARATPE CREDENTIALS
YOUR_UPI_ID = "BHARATPE.8R0I1G1N4X31943@fbpe" 
MERCHANT_NAME = "GBX Store Bar"

bot_app = None

def load_dashboard_menu():
    MINI_APP_URL = os.getenv("RENDER_EXTERNAL_URL", "https://gbxxbb-bot.onrender.com")
    return ReplyKeyboardMarkup([
        [KeyboardButton("📱 My Accounts"), KeyboardButton("➕ New Login")],
        [KeyboardButton("💰 Wallet"), KeyboardButton("🛠️ Customer Care")],
        [KeyboardButton("🛒 Live BigBasket Store", web_app=WebAppInfo(url=MINI_APP_URL))]
    ], resize_keyboard=True, one_time_keyboard=False)

async def verify_user_membership(user_id: int) -> bool:
    global bot_app
    if not bot_app: return False
    for target in REQUIRED_TARGETS:
        try:
            member = await bot_app.bot.get_chat_member(chat_id=target, user_id=user_id)
            if member.status in ['left', 'kicked']: return False
        except TelegramError: return False
    return True

async def show_force_join_menu(update: Update):
    buttons = []
    for target in REQUIRED_TARGETS:
        buttons.append([InlineKeyboardButton(text=TARGET_LABELS[target], url=TARGET_LINKS[target])])
    buttons.append([InlineKeyboardButton(text="🔄 Verify / Check Access", callback_data="verify_all_joins")])
    
    alert_text = "⚠️ **Access Denied!**\n\nBot features use karne ke liye channels aur GC join karein."
    if update.message: 
        await update.message.reply_text(alert_text, reply_markup=InlineKeyboardMarkup(buttons), parse_mode="Markdown")
    elif update.callback_query: 
        await update.callback_query.message.reply_text(alert_text, reply_markup=InlineKeyboardMarkup(buttons), parse_mode="Markdown")

async def start(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if not await verify_user_membership(update.effective_user.id):
        await show_force_join_menu(update)
        return
    await update.message.reply_text("✨ **Dashboard Active!**", reply_markup=load_dashboard_menu(), parse_mode="Markdown")

async def verify_callback_handler(update: Update, context: ContextTypes.DEFAULT_TYPE):
    query = update.callback_query
    await query.answer()
    if await verify_user_membership(query.from_user.id):
        await query.message.delete()
        await query.message.reply_text("✅ **Access Granted! Welcome to GBX Dashboard.**", reply_markup=load_dashboard_menu(), parse_mode="Markdown")
    else:
        await query.answer(text="❌ Saare channels aur GC join nahi kiye!", show_alert=True)

# KEYBOARD NAVIGATION AND PROCESSING HUB
async def handle_text_messages(update: Update, context: ContextTypes.DEFAULT_TYPE):
    user_id = update.effective_user.id
    user_text = update.message.text
    
    MENU_COMMANDS = ["📱 My Accounts", "➕ New Login", "💰 Wallet", "🛠️ Customer Care"]
    if user_text in MENU_COMMANDS:
        USER_STATES[user_id] = None # Reset pending path hooks

    # Amount Input Phase
    if USER_STATES.get(user_id) == "AWAITING_AMOUNT":
        try:
            amount = float(user_text)
            if amount < 10.0:
                await update.message.reply_text("❌ **Payment Rejected!**\n\nMinimum deposit amount **₹10** hai. Kripya enter karein:", parse_mode="Markdown")
                return
            
            USER_STATES[user_id] = None
            tx_ref = f"GBX{user_id}X{random.randint(1000, 9999)}"
            encoded_name = urllib.parse.quote(MERCHANT_NAME)
            upi_payload = f"upi://pay?pa={YOUR_UPI_ID}&pn={encoded_name}&am={amount}&cu=INR&tr={tx_ref}"
            qr_api_url = f"https://api.qrserver.com/v1/create-qr-code/?size=300x300&data={urllib.parse.quote(upi_payload)}"
            
            PENDING_TX[user_id] = {"amount": amount, "tx_ref": tx_ref}
            
            verify_pay_btn = InlineKeyboardMarkup([
                [InlineKeyboardButton(text="🔄 Verify Payment (Enter UTR)", callback_data=f"ask_utr:{amount}")]
            ])
            
            await update.message.reply_photo(
                photo=qr_api_url,
                caption=f"📲 **Scan QR to Pay ₹{amount:.2f}**\n\n🔹 **Merchant:** {MERCHANT_NAME}\n\n⚠️ *Payment complete karke niche click karein aur UTR Ref ID daalein.*",
                reply_markup=verify_pay_btn,
                parse_mode="Markdown"
            )
            return
        except ValueError:
            await update.message.reply_text("❌ Numeric amount daalein (e.g., 50):")
            return

    # Real UTR Input Processing Gate
    elif USER_STATES.get(user_id) == "AWAITING_UTR":
        if not re.match(r"^\d{12}$", user_text.strip()):
            await update.message.reply_text("❌ **Invalid Format!** 12-digit numeric UTR bhejye:")
            return
        
        utr_code = user_text.strip()
        
        if utr_code in USED_UTRS:
            USER_STATES[user_id] = None
            await update.message.reply_text("❌ UTR already used earlier!", reply_markup=load_dashboard_menu())
            return
            
        tx_data = PENDING_TX.get(user_id)
        USER_STATES[user_id] = None 
        
        if tx_data:
            amount = tx_data["amount"]
            
            # Inform user that system is checking
            await update.message.reply_text("⏳ **Payment Verification Pending!**\n\nHamara system aapke payment ko verify kar raha hai. Admin approval hote hi balance credit ho jayega.", reply_markup=load_dashboard_menu())
            
            # 🛠️ FORWARD REQUEST DIRECTLY TO ADMIN FOR REAL VALIDATION
            admin_review_keyboard = InlineKeyboardMarkup([
                [
                    InlineKeyboardButton(text="✅ Accept", callback_data=f"adm_accept:{user_id}:{amount}:{utr_code}"),
                    InlineKeyboardButton(text="❌ Reject", callback_data=f"adm_reject:{user_id}:{utr_code}")
                ]
            ])
            
            await context.bot.send_message(
                chat_id=ADMIN_CHAT_ID,
                text=f"📥 **New Deposit Request Alert!**\n\n👤 User ID: `{user_id}`\n💰 Amount: **₹{amount:.2f}**\n🔢 UTR Submitted: `{utr_code}`\n\n*Apne BharatPe App me transaction status verify karke niche action choose karein.*",
                reply_markup=admin_review_keyboard,
                parse_mode="Markdown"
            )
        else:
            await update.message.reply_text("❌ Transaction session timed out.", reply_markup=load_dashboard_menu())
        return

    # Standard Menu Routings
    if user_text == "🛠️ Customer Care":
        support_keyboard = InlineKeyboardMarkup([[InlineKeyboardButton(text="💬 Open Support Bot", url="https://t.me/gbx_support_bot")]])
        await update.message.reply_text("🙋‍♂️ **GBX Official Customer Support**", reply_markup=support_keyboard, parse_mode="Markdown")
        return
    elif user_text == "💰 Wallet":
        current_bal = USER_BALANCES.get(user_id, 0.0)
        USER_STATES[user_id] = "AWAITING_AMOUNT"
        await update.message.reply_text(f"💳 **Your Wallet Balance:** `₹{current_bal:.2f}`\n\n📥 **Enter deposit amount (Min ₹10):**", parse_mode="Markdown")
        return
    elif user_text == "📱 My Accounts":
        current_bal = USER_BALANCES.get(user_id, 0.0)
        await update.message.reply_text(f"📱 **My Accounts Profile**\n\n🆔 User ID: `{user_id}`\n💰 Cash Ledger: `₹{current_bal:.2f}`", parse_mode="Markdown")
        return
    elif user_text == "➕ New Login":
        await update.message.reply_text("🚧 Login interface active.", parse_mode="Markdown")
        return

    await update.message.reply_text("✨ **Dashboard Active!**", reply_markup=load_dashboard_menu(), parse_mode="Markdown")

async def prompt_utr_verification_handler(update: Update, context: ContextTypes.DEFAULT_TYPE):
    query = update.callback_query
    await query.answer()
    user_id = query.from_user.id
    if user_id in PENDING_TX:
        USER_STATES[user_id] = "AWAITING_UTR"
        await query.message.delete()
        await query.message.reply_text("📝 **UTR Verification Input**\n\nKripya transaction receipt se **12-digit ka UPI Ref No / UTR Code** send karein:")
    else:
        await query.answer(text="❌ Request expired.", show_alert=True)

# 🛠️ ADMIN CALLBACK ACTION INTERCEPTOR LOGIC (Accept / Reject)
async def admin_action_processor_handler(update: Update, context: ContextTypes.DEFAULT_TYPE):
    query = update.callback_query
    await query.answer()
    
    data_nodes = query.data.split(":")
    action = data_nodes[0]
    target_user = int(data_nodes[1])
    
    if action == "adm_accept":
        amount = float(data_nodes[2])
        utr_code = data_nodes[3]
        
        USED_UTRS.add(utr_code)
        PENDING_TX.pop(target_user, None)
        USER_BALANCES[target_user] = USER_BALANCES.get(target_user, 0.0) + amount
        
        # Update Admin Panel Message Layout Strip
        await query.message.edit_text(f"✅ **Approved!** Deposited ₹{amount} to User `{target_user}` (UTR: `{utr_code}`).")
        
        # Notify User Instantly
        success_txt = f"🎉 **Payment Successfully Verified by Admin!**\n"
        success_txt += f"💰 **Added Funds:** +₹{amount:.2f}\n"
        success_txt += f"💳 **Updated Wallet Balance:** **₹{USER_BALANCES[target_user]:.2f}**"
        try:
            await context.bot.send_message(chat_id=target_user, text=success_txt, reply_markup=load_dashboard_menu(), parse_mode="Markdown")
        except: pass
        
    elif action == "adm_reject":
        utr_code = data_nodes[2]
        PENDING_TX.pop(target_user, None)
        
        await query.message.edit_text(f"❌ **Rejected!** Denied fake transaction from user `{target_user}`.")
        
        # Notify Fraud User
        try:
            await context.bot.send_message(chat_id=target_user, text="❌ **Payment Verification Failed!**\n\nAdmin ne aapka transaction request reject kar diya hai kyuki aapka UTR fake tha ya balance receive nahi hua.", reply_markup=load_dashboard_menu(), parse_mode="Markdown")
        except: pass

async def web_app_data_handler(update: Update, context: ContextTypes.DEFAULT_TYPE):
    raw_payload_wire = update.effective_message.web_app_data.data
    try:
        segmented_nodes = raw_payload_wire.split("^")
        extracted_tx_code = segmented_nodes[0].split(":")[1]
        extracted_final_bill = segmented_nodes[1].split(":")[1]
        extracted_location = segmented_nodes[2].split(":")[1]
        
        compiled_receipt = f"🎉 **Order Placed Successfully!**\n🆔 ID: `{extracted_tx_code}`\n💵 Bill: **{extracted_final_bill}**\n📍 Dest: `{extracted_location}`"
        await update.message.reply_text(compiled_receipt, parse_mode="Markdown")
    except Exception:
        await update.message.reply_text(f"🎉 **Order Placed Successfully!**\n📦 Pay: {raw_payload_wire}")

# --- FASTAPI WEB SERVER MODULE ---
api_app = FastAPI()

@api_app.get("/")
def home(): 
    return FileResponse("index.html")

@api_app.get("/api/search")
def proxy_search(query: str = "milk", page: int = 1):
    api_key = os.getenv("PARSE_BOT_API_KEY")
    if not api_key: return {"products": []}
    encoded_query = urllib.parse.quote(query.lower().strip())
    url = f"https://api.parse.bot/scraper/1d9ca2c5-176c-4bc0-9cf3-db9056850958/search_products?page={page}&query={encoded_query}"
    req = urllib.request.Request(url)
    req.add_header("X-API-Key", api_key)
    try:
        with urllib.request.urlopen(req, timeout=8.0) as response:
            raw_data = json.loads(response.read().decode('utf-8'))
            extracted_items = []
            if isinstance(raw_data, list): extracted_items = raw_data
            elif isinstance(raw_data, dict):
                for key in ["results", "products", "data", "items"]:
                    if isinstance(raw_data.get(key), list) and len(raw_data.get(key)) > 0:
                        extracted_items = raw_data[key]
                        break
            formatted_out = []
            for node in extracted_items[:15]:
                title = node.get("title") or node.get("name") or "BigBasket Item"
                price = node.get("price") or node.get("sale_price") or 45
                image = node.get("image") or node.get("image_url") or ""
                formatted_out.append({"title": title, "price": int(price), "image": image})
            return {"products": formatted_out}
    except Exception:
        return {"products": []}

@api_app.on_event("startup")
async def init_webhook_mode():
    global bot_app
    TOKEN = os.getenv("BOT_TOKEN")
    URL = os.getenv("RENDER_EXTERNAL_URL")
    if not TOKEN or not URL: return

    bot_app = Application.builder().token(TOKEN).connect_timeout(30.0).read_timeout(30.0).updater(None).build()
    
    bot_app.add_handler(CommandHandler("start", start))
    bot_app.add_handler(CallbackQueryHandler(verify_callback_handler, pattern="verify_all_joins"))
    bot_app.add_handler(CallbackQueryHandler(prompt_utr_verification_handler, pattern="ask_utr:.*"))
    bot_app.add_handler(CallbackQueryHandler(admin_action_processor_handler, pattern="adm_.*"))
    bot_app.add_handler(MessageHandler(filters.StatusUpdate.WEB_APP_DATA, web_app_data_handler))
    bot_app.add_handler(MessageHandler(filters.ChatType.PRIVATE & filters.TEXT & ~filters.COMMAND, handle_text_messages))
    
    await bot_app.initialize()
    await bot_app.start()
    await bot_app.bot.set_webhook(url=f"{URL}/webhook")

@api_app.post("/webhook")
async def receive_telegram_update(request: Request):
    global bot_app
    if bot_app:
        data = await request.json()
        await bot_app.process_update(Update.de_json(data, bot_app.bot))
    return Response(status_code=200)

if __name__ == "__main__":
    import uvicorn
    port = int(os.getenv("PORT", 8000))
    uvicorn.run(api_app, host="0.0.0.0", port=port)
            

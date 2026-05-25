# python scrape_meeting_calendar.py

import re
import requests
import pandas as pd
from bs4 import BeautifulSoup
import urllib3

urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

START_DATE = "2026-05-25"
END_DATE = "2026-07-31"

VENUE_CODES = {
    # VIC
    "AR": "vic",  # Ararat
    "BA": "vic",  # Ballarat
    "BN": "vic",  # Bendigo
    "IR": "vic",  # Birchip
    "BT": "vic",  # Boort
    "CH": "vic",  # Charlton
    "CO": "vic",  # Cobram
    "CR": "vic",  # Cranbourne
    "EC": "vic",  # Echuca
    "GE": "vic",  # Geelong
    "GU": "vic",  # Gunbower
    "HA": "vic",  # Hamilton
    "HS": "vic",  # Horsham
    "KI": "vic",  # Kilmore
    "MH": "vic",  # Maryborough
    "ML": "vic",  # Mildura
    "MX": "vic",  # Melton
    "OU": "vic",  # Ouyen
    "SP": "vic",  # Shepparton
    "SW": "vic",  # Stawell
    "SH": "vic",  # Swan Hill
    "TE": "vic",  # Terang
    "WN": "vic",  # Wangaratta
    "WR": "vic",  # Warragul
    "WE": "vic",  # Wedderburn
    "YV": "vic",  # Yarra Valley

    # NSW
    "AL": "nsw",  # Albury
    "AR": "nsw",  # Armidale
    "BH": "nsw",  # Bathurst
    "BN": "nsw",  # Bankstown
    "BL": "nsw",  # Blayney
    "CA": "nsw",  # Canberra
    "CL": "nsw",  # Coolamon
    "CR": "nsw",  # Cowra
    "DU": "nsw",  # Dubbo
    "EU": "nsw",  # Eugowra
    "FO": "nsw",  # Forbes
    "GO": "nsw",  # Goulburn
    "GR": "nsw",  # Griffith
    "JU": "nsw",  # Junee
    "LE": "nsw",  # Leeton
    "MA": "nsw",  # Maitland
    "NR": "nsw",  # Newcastle
    "NA": "nsw",  # Narrabri
    "PK": "nsw",  # Parkes
    "PC": "nsw",  # Menangle
    "PE": "nsw",  # Penrith
    "RI": "nsw",  # Riverina Paceway
    "TA": "nsw",  # Tamworth
    "TE": "nsw",  # Temora
    "EY": "nsw",  # Wagga
    "WE": "nsw",  # West Wyalong
    "YG": "nsw",  # Young

    # QLD
    "AP": "qld",  # Albion Park
    "UG": "qld",  # Marburg
    "RE": "qld",  # Redcliffe

    # SA
    "AW": "sa",   # Gawler
    "GD": "sa",   # Globe Derby Park
    "MG": "sa",   # Mount Gambier
    "PP": "sa",   # Port Pirie

    # TAS
    "EH": "tas",  # Hobart
    "LN": "tas",  # Launceston
    "CK": "tas",  # Carrick

    # WA
    "BY": "wa",   # Bunbury
    "ZO": "wa",   # Central Wheatbelt
    "GP": "wa",   # Gloucester Park
    "NG": "wa",   # Narrogin
    "NM": "wa",   # Northam
    "PA": "wa",   # Pinjarra
    "WA": "wa",   # Wagin
}

OUTPUT_FILE = "meeting_calendar.csv"


def clean_text(x):
    return re.sub(r"\s+", " ", x.get_text(" ", strip=True)).strip()


def parse_distance_and_draw(metres_draw_raw):
    distance = ""
    draw = ""

    match = re.search(r"\b(\d{3,4})\b", metres_draw_raw)
    if match:
        distance = match.group(1)
        draw = metres_draw_raw.replace(distance, "", 1).strip()
    else:
        draw = metres_draw_raw.strip()

    return distance, draw


def parse_gait(race_name, class_raw):
    text = f"{race_name} {class_raw}".upper()

    if "TROT" in text:
        return "TROT"
    if "PACE" in text:
        return "PACE"

    return ""

def parse_prizemoney(prize_money_raw):
    text = str(prize_money_raw)

    match = re.search(r"\$[\d,]+", text)
    if not match:
        return ""

    return int(match.group(0).replace("$", "").replace(",", ""))


def parse_nr_range(class_raw):
    text = str(class_raw).upper()

    match = re.search(r"\(NR\s*(\d+)\)", text)
    if match:
        return "", int(match.group(1))

    min_nr = ""
    max_nr = ""

    match = re.search(r"NR\s*(\d+)\s*(?:TO|-)\s*(\d+)", text)
    if match:
        return int(match.group(1)), int(match.group(2))

    match = re.search(r"NR\s*UP\s*TO\s*(\d+)", text)
    if match:
        return "", int(match.group(1))

    match = re.search(r"NR\s*(\d+)\s*(?:OR\s+BETTER|AND\s+BETTER)", text)
    if match:
        return int(match.group(1)), ""

    match = re.search(r"NR\s*(\d+)\s*\+", text)
    if match:
        return int(match.group(1)), ""

    return min_nr, max_nr


def parse_win_range(race_name, class_raw, other_conditions_raw):
    race_name_text = str(race_name).upper()
    class_text = str(class_raw).upper()
    other_text = str(other_conditions_raw).upper()
    combined_text = f"{race_name_text} {class_text} {other_text}"

    min_wins = ""
    max_wins = ""

    # Strong explicit lifetime-wins restrictions
    match = re.search(r"RESTRICTED\s+TO\s+HORSES\s+WITH\s+(\d+)\s*-\s*(\d+)\s+LIFETIME\s+WINS?", combined_text)
    if match:
        return int(match.group(1)), int(match.group(2))

    match = re.search(r"RESTRICTED\s+TO\s+HORSES\s+WITH\s+(\d+)\s*-\s*(\d+)\s+WINS?", combined_text)
    if match:
        return int(match.group(1)), int(match.group(2))

    match = re.search(r"(\d+)\s*-\s*(\d+)\s*LTW", combined_text)
    if match:
        return int(match.group(1)), int(match.group(2))

    # Max-only lifetime wins restrictions
    match = re.search(r"RESTRICTED\s+TO\s+HORSES\s+WITH\s+NO\s+MORE\s+THAN\s+(\d+)\s+LIFETIME\s+WINS?", combined_text)
    if match:
        return "", int(match.group(1))

    match = re.search(r"RESTRICTED\s+TO\s+HORSES\s+WITH\s+NO\s+MORE\s+THAN\s+(\d+)\s+WINS?", combined_text)
    if match:
        return "", int(match.group(1))

    match = re.search(r"RESTRICTED\s+TO\s+HORSES\s+WITH\s+(\d+)\s+LIFETIME\s+WIN", combined_text)
    if match:
        return int(match.group(1)), int(match.group(1))

    # Maiden / nil lifetime wins
    if "NIL LIFETIME WINS" in combined_text or "MAIDEN" in combined_text:
        return "", 0

    return min_wins, max_wins


def parse_flags(race_name, class_raw, other_conditions_raw):
    race_name_text = str(race_name).upper()
    class_text = str(class_raw).upper()
    other_text = str(other_conditions_raw).upper()

    combined_text = f"{race_name_text} {class_text} {other_text}"

    return {
        "IsVicbredOnly": "VICBRED" in class_text or "VICBRED ONLY" in other_text,
        "IsMaresOnly": "MARES" in class_text or "MARE" in class_text,
        "IsMaresAllowance": (
            "MARES ALLOWANCE" in other_text
            or "MARE ALLOWANCE" in other_text
            or "MARES CONCESSION" in other_text
            or "MARE CONCESSION" in other_text
            or ("MARES" in other_text and "ALLOWANCE" in other_text)
        ),
        "IsMaiden": "MAIDEN" in combined_text or "NIL LIFETIME WINS" in combined_text,
        "NoClaimsOrAllowances": (
            "NO CLAIMS OR ALLOWANCES" in combined_text
            or "NO CONCESSION CLAIMS" in combined_text
        ),
        "ClaimsForEligibility": "CLAIMS" in combined_text and "ELIGIBILITY PURPOSES" in combined_text,
        "ClaimsForDrawOnly": "WITHIN THE BARRIER DRAW" in combined_text,
        "IsRestricted": "RESTRICTED" in combined_text,
    }

def parse_age_range(race_name, class_raw, other_conditions_raw):
    text = f"{race_name} {class_raw} {other_conditions_raw}".upper()

    min_age = ""
    max_age = ""

    match = re.search(r"(\d+)\s*YO\s*&\s*OLDER", text)
    if match:
        return int(match.group(1)), ""

    match = re.search(r"(\d+)\s*YO\s*(?:AND|&)\s*OLDER", text)
    if match:
        return int(match.group(1)), ""

    match = re.search(r"(\d+)\s*YO\s*\+", text)
    if match:
        return int(match.group(1)), ""

    match = re.search(r"(\d+)\s*YEAR\s*OLD\s*(?:AND|&)\s*OLDER", text)
    if match:
        return int(match.group(1)), ""

    match = re.search(r"(\d+)\s*YO", text)
    if match:
        age = int(match.group(1))
        return age, age

    return min_age, max_age


def scrape_program(meeting_code, state):
    url = f"https://legacy.harness.org.au/meeting-programme.cfm?rm={meeting_code}&state={state}"

    print(f"🌐 Scraping {meeting_code}: {url}")

    headers = {
        "User-Agent": "Mozilla/5.0"
    }

    r = requests.get(url, headers=headers, timeout=30, verify=False)
    r.raise_for_status()

    soup = BeautifulSoup(r.text, "html.parser")
    page_text = soup.get_text("\n", strip=True)

    rows = []

    tables = soup.find_all("table")
    # print(f"   Tables found: {len(tables)}")

    target_table = None

    for i, table in enumerate(tables):
        table_rows = table.find_all("tr")
        if not table_rows:
            continue

        first_row_cells = table_rows[0].find_all(["td", "th"])
        first_row_values = [clean_text(c).lower() for c in first_row_cells]

        # print(f"Table {i} first row: {first_row_values}")

        if (
            "race code" in first_row_values
            and "start" in first_row_values
            and "race name" in first_row_values
            and "total stakes" in first_row_values
        ):
            target_table = table
            print(f"✅ Selected table {i} as meeting program table")
            break

    if target_table is None:
        if "trial" in page_text.lower():
            print(f"ℹ️ Skipping trial meeting: {meeting_code}")
        else:
            print(f"⚠️ Could not find standard race program table: {meeting_code}")
        return rows

    venue = ""
    time_of_day = ""
    meeting_date = ""
    weekday = ""

    h2 = soup.find("h2")
    h2_text = clean_text(h2) if h2 else ""

    print(f"Meeting title found: {h2_text}")

    title_match = re.search(
        r"^(.+?)\s+([A-Za-z]+)\s+(\d{1,2}\s+[A-Za-z]+\s+\d{4})\s+\((Day|Twilight|Night)\s+meeting\)",
        h2_text,
        re.IGNORECASE,
    )

    if title_match:
        venue = title_match.group(1).strip().title()
        weekday = title_match.group(2).strip().title()
        meeting_date = title_match.group(3).strip()

        VENUE_NORMALISATIONS = {
            "Wagga At Riverina Paceway": "Wagga",
            "Nswhrc At Tabcorp Pk Menangle": "Menangle",
        }

        venue = VENUE_NORMALISATIONS.get(venue, venue)

        time_of_day = title_match.group(4).strip().title()
    else:
        print(f"⚠️ Could not parse meeting title from h2: {h2_text}")

    noms_close = ""
    acceptances = ""
    race_fields = ""

    noms_match = re.search(r"Nominations close:\s*(.+)", page_text, re.IGNORECASE)
    acc_match = re.search(r"Acceptances:\s*(.+)", page_text, re.IGNORECASE)
    fields_match = re.search(r"Race fields available:\s*(.+)", page_text, re.IGNORECASE)

    if noms_match:
        noms_close = clean_datetime_text(noms_match.group(1))
    if acc_match:
        acceptances = clean_datetime_text(acc_match.group(1))
    if fields_match:
        race_fields = clean_datetime_text(fields_match.group(1))

    for tr in target_table.find_all("tr"):
        cells = tr.find_all(["td", "th"])

        if len(cells) < 7:
            continue

        values = [clean_text(c) for c in cells]

        if values[0].upper() == "RACE CODE":
            continue

        race_code = values[0]

        if not race_code:
            continue

        start_type = values[1]
        race_name = values[2]
        prize_money_raw = values[3]
        prizemoney = parse_prizemoney(prize_money_raw)
        class_raw = values[4]
        metres_draw_raw = values[5]
        other_conditions_raw = values[6]

        distance, draw = parse_distance_and_draw(metres_draw_raw)
        gait = parse_gait(race_name, class_raw)
        min_nr, max_nr = parse_nr_range(class_raw)
        min_wins, max_wins = parse_win_range(
            race_name,
            class_raw,
            other_conditions_raw,
        )
        min_age, max_age = parse_age_range(
            race_name,
            class_raw,
            other_conditions_raw,
        )
        flags = parse_flags(
            race_name,
            class_raw,
            other_conditions_raw,
        )

        rows.append({
            "URL": url,
            "MeetingCode": meeting_code,
            "State": state.upper(),
            "Venue": venue,
            "TimeOfDay": time_of_day,
            "Date": meeting_date,
            "Weekday": weekday,
            "NomsClose": noms_close,
            "Acceptances": acceptances,
            "RaceFieldsAvailable": race_fields,
            "RaceCode": race_code,
            "StartType": start_type,
            "RaceName": race_name,
            "PrizeMoneyRaw": prize_money_raw,
            "Prizemoney": prizemoney,
            "ClassRaw": class_raw,
            "MetresDrawRaw": metres_draw_raw,
            "OtherConditionsRaw": other_conditions_raw,
            "Distance": distance,
            "Draw": draw,
            "Gait": gait,
            "MinNR": min_nr,
            "MaxNR": max_nr,
            "MinWins": min_wins,
            "MaxWins": max_wins,
            "MinAge": min_age,
            "MaxAge": max_age,
            **flags,
        })

    print(f"✅ Rows scraped: {len(rows)}")
    return rows

def clean_datetime_text(value):
    text = str(value)
    text = text.replace("\xa0", " ")
    text = text.replace("Â", "")
    text = re.sub(r"\s+", " ", text).strip()
    return text


def main():
    all_rows = []

    date_range = pd.date_range(START_DATE, END_DATE)

    for date_value in date_range:
        date_code = date_value.strftime("%d%m%y")

        for venue_code, state in VENUE_CODES.items():
            meeting_code = f"{venue_code}{date_code}"

            try:
                rows = scrape_program(meeting_code, state)
                if rows:
                    all_rows.extend(rows)
            except Exception as e:
                print(f"⚠️ Skipped {meeting_code} ({state}): {e}")

    if not all_rows:
        print("❌ No rows scraped")
        return

    df = pd.DataFrame(all_rows)
    df.to_csv(OUTPUT_FILE, index=False)

    print(f"\n✅ Saved {len(df)} rows to {OUTPUT_FILE}")
    print(df.head(10).to_string(index=False))


if __name__ == "__main__":
    main()
import { languageOptions } from "@/lib/languages";

/** Main language and other languages, as a list to choose from. Read back with `readLanguages`. */
export function LanguageFields({ current }: { current: string[] }) {
  const options = languageOptions(current);
  const main = current[0] ?? "en";
  return (
    <>
      <div>
        <label htmlFor="mainLanguage">Your main language with customers</label>
        <select id="mainLanguage" name="mainLanguage" defaultValue={main} required>
          {options.map(([code, name]) => (
            <option key={code} value={code}>
              {name}
            </option>
          ))}
        </select>
        <p className="hint">Used when it is not clear in which language an email was written.</p>
      </div>
      <fieldset>
        <legend className="text-sm font-medium text-stone-800">Other languages you write to customers in</legend>
        <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1.5 sm:grid-cols-4">
          {options.map(([code, name]) => (
            <label key={code} className="flex items-center gap-2 font-normal">
              <input type="checkbox" name="language" value={code} defaultChecked={current.slice(1).includes(code)} />
              {name}
            </label>
          ))}
        </div>
        <p className="hint mt-2">
          Tick none if you use one language. A customer is answered in the language they wrote in; mail in a language
          you did not tick still gets a draft, and your daily brief points it out.
        </p>
      </fieldset>
    </>
  );
}
